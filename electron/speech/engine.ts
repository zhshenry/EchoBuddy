import { utilityProcess, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import { validateSpeechWave } from '../../shared/speech-audio';
import type { SpeechResult } from '../../shared/speech-contracts';

type WorkerMessage = { type: 'ready' } | { type: 'error'; id?: string; message: string } |
  { type: 'result'; id: string; result: SpeechResult };
const idleMs = 5 * 60 * 1000;

export class SpeechEngine {
  private child?: UtilityProcess;
  private loaded?: Promise<void>;
  private failLoad?: (error: Error) => void;
  private pending?: { id: string; resolve: (value: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
  private queue: Promise<unknown> = Promise.resolve();
  private idle?: NodeJS.Timeout;
  private activeId?: string;
  private requestId = 0;

  constructor(private readonly directory: string) {}

  begin(id: string): void {
    this.activeId = id;
    clearTimeout(this.idle);
    // Audio capture starts in parallel. A failed warm-up is also reported by the first inference request.
    void Promise.resolve().then(() => this.load()).catch(() => {});
  }

  transcribe(sessionId: string, audio: Uint8Array): Promise<string> {
    validateSpeechWave(audio);
    const next = this.queue.then(async () => {
      if (sessionId !== this.activeId) throw new Error('本次听写已结束。');
      await this.load();
      if (sessionId !== this.activeId || !this.child) throw new Error('本次听写已结束。');
      return new Promise<string>((resolve, reject) => {
        const id = String(++this.requestId);
        const timer = setTimeout(() => this.close('离线转写超时，请重试。'), 120000);
        this.pending = { id, resolve, reject, timer };
        this.child!.postMessage({ id, audio, language: 'auto' });
      });
    });
    this.queue = next.catch(() => {});
    return next;
  }

  end(id: string): void {
    if (this.activeId !== id) return;
    this.activeId = undefined;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), idleMs);
    this.idle.unref();
  }

  close(message = '离线语音引擎已关闭。'): void {
    const error = new Error(message), child = this.child;
    this.child = undefined;
    this.loaded = undefined;
    clearTimeout(this.idle);
    this.failLoad?.(error);
    this.failLoad = undefined;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
    child?.kill();
  }

  private load(): Promise<void> {
    if (this.loaded) return this.loaded;
    const child = utilityProcess.fork(join(__dirname, 'speech-worker.cjs'), [this.directory], {
      stdio: 'ignore', serviceName: 'EchoBuddy 离线语音',
    });
    this.child = child;
    this.loaded = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => this.close('离线语音引擎准备超时。'), 60000);
      this.failLoad = error => { clearTimeout(timeout); reject(error); };
      child.on('message', (message: WorkerMessage) => {
        if (this.child !== child) return;
        if (message.type === 'ready') {
          clearTimeout(timeout);
          this.failLoad = undefined;
          resolve();
          return;
        }
        if (message.type === 'error' && !message.id) { this.close(message.message); return; }
        const pending = this.pending;
        if (!pending || message.id !== pending.id) return;
        this.pending = undefined;
        clearTimeout(pending.timer);
        if (message.type === 'result') pending.resolve(message.result.text);
        else pending.reject(new Error(message.message));
      });
      child.once('exit', () => {
        if (this.child === child) this.close('离线语音引擎已退出，请重试。');
      });
    });
    return this.loaded;
  }
}
