import { randomUUID } from 'node:crypto';
import { SHORT_DICTATION_MAX_SECONDS, type DictationState } from '../shared/desktop';
import type { SpeechEngine } from './speech/engine';
import type { WindowsInput, WriteResult } from './windows-input';

type Session = { id: string; target: Promise<boolean>; completing: boolean; stopTimer?: NodeJS.Timeout };

export class Dictation {
  private state: DictationState = { phase: 'idle', sessionId: null, pending: '', message: '', reveal: 0 };
  private session?: Session;
  private writing = false;

  constructor(
    private readonly engine: Pick<SpeechEngine, 'begin' | 'transcribe' | 'end'>,
    private readonly input: Pick<WindowsInput, 'capture' | 'insert' | 'clear'>,
    private readonly publish: (state: DictationState) => void,
    private readonly writeClipboard: (text: string) => void,
  ) {}

  snapshot(): DictationState { return this.state; }
  blocksInstall(): boolean { return this.state.phase !== 'idle' || this.writing || !!this.state.pending; }

  toggle(shortcut?: string): void {
    if (this.state.phase === 'finishing' || this.writing) return;
    if (this.session) {
      clearTimeout(this.session.stopTimer);
      this.set({ phase: 'finishing' });
      return;
    }
    if (this.state.pending) {
      this.set({ reveal: this.state.reveal + 1 });
      return;
    }
    const id = randomUUID();
    this.session = { id, target: this.input.capture(shortcut).catch(() => false), completing: false };
    this.engine.begin(id);
    this.set({ sessionId: id, phase: 'preparing', message: '' });
  }

  recording(id: string): void {
    const session = this.session;
    if (!session || session.id !== id || this.state.phase !== 'preparing') return;
    session.stopTimer = setTimeout(() => {
      if (this.session === session) this.toggle();
    }, SHORT_DICTATION_MAX_SECONDS * 1000);
    session.stopTimer.unref();
    this.set({ phase: 'recording' });
  }

  transcribe(id: string, audio: Uint8Array): Promise<string> {
    if (id !== this.session?.id || this.session.completing) return Promise.reject(new Error('本次听写已结束。'));
    return this.engine.transcribe(id, audio);
  }

  async complete(id: string, transcript: string, error = ''): Promise<void> {
    const session = this.session;
    if (!session || session.id !== id || session.completing) return;
    clearTimeout(session.stopTimer);
    session.completing = true;
    this.set({ phase: 'finishing' });
    const text = transcript.trim();
    let pending = '', message = error;
    try {
      if (error) pending = text;
      else if (!text) message = '这次没有识别到语音。';
      else {
        const result = await session.target ? await this.input.insert(text, true) : 'moved';
        if (result !== 'written') { pending = text; message = this.writeMessage(result, true); }
      }
    } catch {
      pending = text;
      message = '无法写入原光标，转写已保留。';
    } finally {
      this.engine.end(id);
      this.input.clear();
      this.session = undefined;
      this.set({ phase: 'idle', sessionId: null, pending, message, reveal: this.state.reveal + Number(!!pending) });
    }
  }

  async insertPending(): Promise<void> {
    const text = this.state.pending;
    if (this.session || this.writing || !text) return;
    this.writing = true;
    try {
      const result = await this.input.insert(text, false);
      if (result === 'written') this.set({ pending: '', message: '' });
      else this.set({ message: this.writeMessage(result, false) });
    } catch { this.set({ message: '无法写入，请复制这段文字。' }); }
    finally { this.writing = false; }
  }

  copyPending(): void {
    if (this.writing || !this.state.pending) return;
    try {
      this.writeClipboard(this.state.pending);
      this.set({ pending: '', message: '已复制本次转写。' });
    } catch { this.set({ message: '复制未完成，请重试。' }); }
  }

  showMessage(message: string): void { this.set({ message }); }

  private set(changes: Partial<DictationState>): void {
    this.state = { ...this.state, ...changes };
    this.publish(this.state);
  }

  private writeMessage(result: WriteResult, original: boolean): string {
    if (result === 'partial') return '可能已写入部分内容。请检查输入框，全文已保留。';
    return original ? '原光标已移动或无法确认，转写已保留。' : '请将光标放在可编辑的输入框后重试，或复制这段文字。';
  }
}
