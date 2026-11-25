import { randomUUID } from 'node:crypto';
import { SHORT_DICTATION_MAX_SECONDS, type DictationState, type WriteTiming } from '../shared/desktop';
import type { Hotword } from '../shared/hotwords';
import type { SpeechEngine } from './speech/engine';
import type { CaptureResult, WindowsInput, WriteResult } from './windows-input';
import { recordFeedbackEvent } from './feedback-service';

type Streaming = { written: string; writes: Promise<void>; failure?: Exclude<WriteResult, 'written'> };
type Session = { id: string; target: Promise<CaptureResult>; completing: boolean; hotwords: readonly Hotword[]; stopTimer?: NodeJS.Timeout; stream?: Streaming };

export class Dictation {
  private state: DictationState = { phase: 'idle', sessionId: null, recordingStartedAt: null, hotwordsActive: false, pending: '', message: '', reveal: 0, clearRevision: 0 };
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

  toggle(shortcut?: string, timing: WriteTiming = 'sentence', hotwords: readonly Hotword[] = []): void {
    if (this.state.phase === 'finishing' || this.writing) return;
    if (this.session) {
      clearTimeout(this.session.stopTimer);
      recordFeedbackEvent({ stage: 'dictation:stop', status: 'requested', operationId: this.session.id });
      this.set({ phase: 'finishing' });
      return;
    }
    const id = randomUUID();
    const streaming = timing === 'streaming';
    recordFeedbackEvent({ stage: 'dictation:start', status: timing, operationId: id });
    this.session = {
      id, target: this.input.capture(shortcut, streaming).catch(() => 'unavailable' as const), completing: false,
      hotwords: structuredClone(hotwords),
      stream: streaming ? { written: '', writes: Promise.resolve() } : undefined,
    };
    this.engine.begin(id);
    this.set({ sessionId: id, phase: 'preparing', hotwordsActive: hotwords.length > 0, pending: '', message: '' });
  }

  recording(id: string): void {
    const session = this.session;
    if (!session || session.id !== id || this.state.phase !== 'preparing') return;
    session.stopTimer = setTimeout(() => {
      if (this.session === session) this.toggle();
    }, SHORT_DICTATION_MAX_SECONDS * 1000);
    session.stopTimer.unref();
    this.set({ phase: 'recording', recordingStartedAt: Date.now() });
  }

  transcribe(id: string, audio: Uint8Array): Promise<string> {
    if (id !== this.session?.id || this.session.completing) return Promise.reject(new Error('本次听写已结束。'));
    return this.engine.transcribe(id, audio, this.session.hotwords);
  }

  writeProgress(id: string, text: string): Promise<void> | undefined {
    const session = this.session;
    const stream = session?.stream;
    if (session?.id !== id || !stream || this.state.phase !== 'recording') return;
    stream.writes = stream.writes.then(async () => {
      if (this.state.phase !== 'recording' || stream.failure || !text.startsWith(stream.written)) return;
      const remainder = text.slice(stream.written.length);
      if (!remainder) return;
      const target = await session.target;
      if (this.state.phase !== 'recording' || target === 'paste-on-stop') return;
      try {
        const result = target === 'captured' ? await this.input.insert(remainder, true) : 'moved';
        if (result === 'written') stream.written = text;
        else stream.failure = result;
      } catch { stream.failure = 'unavailable'; }
    });
    return stream.writes;
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
      const stream = session.stream;
      if (stream) await stream.writes;
      const written = stream?.written ?? '';
      const aligned = text.startsWith(written);
      const remainder = aligned ? text.slice(written.length) : text;
      if (stream?.failure === 'partial' || stream?.failure === 'paste-unconfirmed') {
        pending = text;
        message = this.writeMessage('partial', true);
      } else if (error) pending = remainder;
      else if (!text) message = '这次没有识别到语音。';
      else if (!aligned) {
        pending = text;
        message = '定稿有改动，请核对已写入的文字。';
      } else if (remainder) {
        const result = stream?.failure ?? ((await session.target) === 'unavailable'
          ? 'moved' : await this.input.insert(remainder, true));
        if (result !== 'written') {
          pending = result === 'partial' ? text : remainder;
          message = this.writeMessage(result, true);
        }
      }
    } catch {
      pending = text;
      message = '无法写入原光标，转写已保留。';
    } finally {
      recordFeedbackEvent({ stage: 'dictation:complete', status: error ? 'failed' : pending ? 'retained' : text ? 'completed' : 'empty',
        ...(error ? { errorCode: 'DICTATION_FAILED' } : {}), operationId: id });
      this.engine.end(id);
      this.input.clear();
      this.session = undefined;
      this.set({ phase: 'idle', sessionId: null, recordingStartedAt: null, hotwordsActive: false, pending, message, reveal: this.state.reveal + Number(!!pending) });
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

  clearTranscript(): void {
    if (this.session || this.writing) return;
    this.set({ pending: '', message: '', clearRevision: this.state.clearRevision + 1 });
  }

  showMessage(message: string): void { this.set({ message }); }

  private set(changes: Partial<DictationState>): void {
    this.state = { ...this.state, ...changes };
    this.publish(this.state);
  }

  private writeMessage(result: WriteResult, original: boolean): string {
    if (result === 'paste-unconfirmed') return '已发送粘贴。转写仍在剪贴板，请核对输入框。';
    if (result === 'partial') return original ? '可能已写入部分内容。请检查输入框，全文已保留。'
      : '可能已经写入。请先核对输入框，转写已保留。';
    return original ? '原光标已移动或无法确认，转写已保留。' : '请将光标放在可编辑的输入框后重试，或复制这段文字。';
  }
}
