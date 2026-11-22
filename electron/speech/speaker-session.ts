import { safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { validateSpeechWave } from '../../shared/speech-audio';
import { VOICEPRINT_CLIP_SECONDS, VOICEPRINT_SAMPLES, type SpeakerCapture, type SpeakerCaptureResult } from '../../shared/speaker-contracts';
import { cosine, normalizeVoiceprint, voiceprintRevision, voiceprintThreshold } from './speaker-timeline';
import type { SpeechEngine } from './engine';

export class SpeakerSession {
  private profile: number[] | null;
  private enrollment: number[][] = [];
  private session?: { id: string; mode: SpeakerCapture; processing: boolean };

  constructor(private readonly speech: SpeechEngine, private readonly path: string) {
    this.profile = this.loadProfile();
  }

  get active(): boolean { return !!this.session; }
  get recording(): boolean { return !!this.session && !this.session.processing; }
  get enrolled(): boolean { return !!this.profile; }
  get voiceprint(): number[] | null { return this.profile; }

  begin(mode: SpeakerCapture): string | null {
    if (this.session || (mode !== 'enroll' && mode !== 'analyze')) return null;
    if (mode === 'analyze') this.enrollment = [];
    const id = randomUUID();
    this.session = { id, mode, processing: false };
    this.speech.begin(id);
    return id;
  }

  async finish(id: string, audio: Uint8Array): Promise<SpeakerCaptureResult> {
    const session = this.session;
    if (session?.id !== id || session.processing) throw new Error('本次录音已结束。');
    session.processing = true;
    try {
      if (session.mode === 'analyze') {
        const lines = await this.speech.speakers(id, audio, this.profile);
        return { type: 'transcript', lines };
      }
      if (validateSpeechWave(audio) > VOICEPRINT_CLIP_SECONDS) throw new Error('每条声纹样本最长 20 秒。');
      const sample = await this.speech.embedding(id, audio);
      if (this.session !== session) throw new Error('本次录入已取消。');
      if (!sample) throw new Error('人声太短，请重新录制至少 3 秒的清晰人声。');

      if (this.enrollment.length < VOICEPRINT_SAMPLES) {
        if (this.enrollment.some(previous => cosine(previous, sample) < voiceprintThreshold)) {
          throw new Error('这段和前面的声音差别较大，请由同一人重新录制。');
        }
        this.enrollment.push(sample);
        return { type: 'enrollment', saved: false, samples: this.enrollment.length };
      }

      const merged = normalizeVoiceprint(sample.map((_, i) => this.enrollment.reduce((sum, clip) => sum + clip[i], 0)));
      if (!merged || cosine(merged, sample) < voiceprintThreshold) {
        throw new Error('验证没有通过，请再换一句话确认。');
      }
      this.saveProfile(merged);
      this.enrollment = [];
      return { type: 'enrollment', saved: true, samples: VOICEPRINT_SAMPLES };
    } finally {
      if (this.session === session) {
        this.session = undefined;
        this.speech.end(id);
      }
    }
  }

  cancel(keepSamples = false): void {
    if (!keepSamples) this.enrollment = [];
    const session = this.session;
    if (!session) return;
    this.session = undefined;
    this.speech.end(session.id);
    if (session.processing) this.speech.close('本次处理已取消。');
  }

  deleteProfile(): void {
    if (this.session) throw new Error('请先结束本次录音。');
    try { rmSync(this.path, { force: true }); }
    catch { throw new Error('无法删除本机声纹，请重试。'); }
    this.profile = null;
    this.enrollment = [];
  }

  private loadProfile(): number[] | null {
    try {
      const value = JSON.parse(safeStorage.decryptString(readFileSync(this.path)));
      return value.revision === voiceprintRevision && Array.isArray(value.vector) && value.vector.every(Number.isFinite)
        ? normalizeVoiceprint(value.vector) : null;
    } catch { return null; }
  }

  private saveProfile(vector: number[]): void {
    const temporary = this.path + '.tmp';
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error();
      writeFileSync(temporary, safeStorage.encryptString(JSON.stringify({ revision: voiceprintRevision, vector })));
      renameSync(temporary, this.path);
      this.profile = vector;
    } catch {
      try { rmSync(temporary, { force: true }); } catch {}
      throw new Error('无法加密保存声纹，请重试。');
    }
  }
}
