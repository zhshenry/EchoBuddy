import { encodeSpeechWave } from '../../shared/speech-audio';
import { SPEECH_SAMPLE_RATE as rate } from '../../shared/speech-contracts';
import { Microphone } from './microphone';

type Events = {
  level(value: number): void;
  words(lines: string[], draft: string): void;
  progress?(lines: string[]): void;
  ended(): void;
};

const words = new Intl.Segmenter('zh', { granularity: 'word' });

export function stableDraftPrefix(previous: string, current: string): string {
  const left = Array.from(previous), right = Array.from(current);
  let matched = 0;
  while (matched < left.length && left[matched] === right[matched]) matched++;
  const confirmed = Math.min(matched, right.length - 2);
  if (confirmed < 2) return '';

  // Hold back the newest draft's tail and only insert complete words or numbers.
  const limit = right.slice(0, confirmed).join('').length;
  let end = 0;
  for (const { index, segment } of words.segment(current)) {
    if (index + segment.length > limit) break;
    end = index + segment.length;
  }
  const prefix = current.slice(0, end).trimEnd();
  return Array.from(prefix).length >= 2 ? prefix : '';
}

export class Capture {
  private readonly microphone = new Microphone(frame => this.accept(frame), () => this.events.ended());
  private closed = false;
  private frames: Float32Array[] = [];
  private length = 0;
  private silence = 0;
  private hasVoice = false;
  private segment = 0;
  private lastDraft = 0;
  private draftInFlight = false;
  private finalPasses = Promise.resolve();
  private error?: unknown;
  private lines: string[] = [];
  private draft = '';

  constructor(private readonly id: string, private readonly events: Events) {}

  start(): Promise<void> { return this.microphone.start(); }

  confirmed(): string[] { return [...this.lines]; }

  async stop(): Promise<string[]> {
    this.closed = true;
    await this.microphone.stop();
    this.commit();
    await this.finalPasses;
    this.events.level(0);
    if (this.error) throw this.error;
    return this.confirmed();
  }

  private async recognize(frames: Float32Array[], length: number): Promise<string> {
    const pcm = new Float32Array(length);
    let offset = 0;
    for (const frame of frames) { pcm.set(frame, offset); offset += frame.length; }
    return (await window.echoBuddy.transcribe(this.id, encodeSpeechWave(pcm))).trim();
  }

  private accept(frame: Float32Array) {
    let energy = 0;
    for (const sample of frame) energy += sample * sample;
    const rms = Math.sqrt(energy / frame.length);
    this.events.level(Math.min(1, rms * 6));
    this.frames.push(frame);
    this.length += frame.length;
    if (rms > 0.009) { this.hasVoice = true; this.silence = 0; }
    else this.silence += frame.length;

    if ((this.hasVoice && this.silence >= rate * 0.64) || this.length >= rate * 14) {
      this.commit();
      return;
    }
    const draftInterval = this.events.progress ? 0.7 : 1.65;
    if (!this.closed && this.hasVoice && !this.draftInFlight && this.length - this.lastDraft >= rate * draftInterval) {
      this.lastDraft = this.length;
      const segment = this.segment;
      this.draftInFlight = true;
      void this.recognize(this.frames, this.length).then(async text => {
        if (!this.closed && segment === this.segment && text) {
          const progress = this.events.progress;
          const stable = progress ? stableDraftPrefix(this.draft, text) : '';
          this.draft = text;
          this.events.words(this.confirmed(), text);
          if (stable && progress) {
            await this.finalPasses;
            if (!this.closed && segment === this.segment && !this.error) progress([...this.lines, stable]);
          }
        }
      }).catch(() => {
        // Final passes still receive the full segment.
      }).finally(() => { this.draftInFlight = false; });
    }
  }

  private commit() {
    const frames = this.frames, length = this.length;
    this.frames = [];
    this.length = this.silence = this.lastDraft = 0;
    this.hasVoice = false;
    this.segment++;
    this.draft = '';
    if (length < 512) return;
    this.finalPasses = this.finalPasses.then(async () => {
      const text = await this.recognize(frames, length);
      if (text) this.lines.push(text);
      this.events.words(this.confirmed(), this.draft);
      if (text && !this.closed && !this.error) this.events.progress?.(this.confirmed());
    }).catch(error => { this.error = error; });
  }
}
