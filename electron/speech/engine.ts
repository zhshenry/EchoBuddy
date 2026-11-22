import { utilityProcess, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import { validateSpeechWave } from '../../shared/speech-audio';
import type { SpeechLanguage } from '../../shared/speech-contracts';
import type { SpeakerLine } from '../../shared/speaker-contracts';
import type { MeetingChunk, SpeechOperation, WorkerResult } from './worker-contract';

type WorkerMessage = { type: 'ready' } | { type: 'error'; id?: string; message: string } |
  { type: 'result'; id: string; result: WorkerResult };
const idleMs = 5 * 60 * 1000;

export class SpeechEngine {
  private child?: UtilityProcess;
  private loaded?: Promise<void>;
  private failLoad?: (error: Error) => void;
  private pending?: { id: string; resolve: (value: WorkerResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
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

  async transcribe(sessionId: string, audio: Uint8Array): Promise<string> {
    const result = await this.request(sessionId, audio, { type: 'transcribe', language: 'auto' });
    if (result.type !== 'transcribe') throw new Error('本地转写失败，请重试。');
    return result.result.text;
  }

  async embedding(sessionId: string, audio: Uint8Array, meeting = false): Promise<number[] | null> {
    const result = await this.request(sessionId, audio, { type: 'embedding', meeting });
    if (result.type !== 'embedding') throw new Error('提取声纹失败，请重试。');
    return result.embedding;
  }

  async meetingChunk(sessionId: string, audio: Uint8Array, language: SpeechLanguage): Promise<MeetingChunk> {
    const result = await this.request(sessionId, audio, { type: 'meeting', language });
    if (result.type !== 'meeting') throw new Error('本地转写失败，请重试。');
    return result.chunk;
  }

  async speakers(sessionId: string, audio: Uint8Array, voiceprint: number[] | null): Promise<SpeakerLine[]> {
    const result = await this.request(sessionId, audio, { type: 'speakers', voiceprint });
    if (result.type !== 'speakers') throw new Error('说话人标注失败，请重试。');
    return result.lines;
  }

  private request(sessionId: string, audio: Uint8Array, operation: SpeechOperation): Promise<WorkerResult> {
    validateSpeechWave(audio);
    const next = this.queue.then(async () => {
      if (sessionId !== this.activeId) throw new Error('本次听写已结束。');
      await this.load();
      if (sessionId !== this.activeId || !this.child) throw new Error('本次听写已结束。');
      return new Promise<WorkerResult>((resolve, reject) => {
        const id = String(++this.requestId);
        const timer = setTimeout(() => this.close('离线转写超时，请重试。'), 120000);
        this.pending = { id, resolve, reject, timer };
        this.child!.postMessage({ ...operation, id, audio });
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
        if (message.type === 'result') pending.resolve(message.result);
        else pending.reject(new Error(message.message));
      });
      child.once('exit', () => {
        if (this.child === child) this.close('离线语音引擎已退出，请重试。');
      });
    });
    return this.loaded;
  }
}
