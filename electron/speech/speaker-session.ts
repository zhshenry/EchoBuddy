import { safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { validateSpeechWave } from '../../shared/speech-audio';
import { isVoiceprintId, VOICEPRINT_CLIP_SECONDS, VOICEPRINT_SAMPLES, type SpeakerCapture, type SpeakerCaptureResult,
  type VoiceprintEnrollment, type VoiceprintId, type VoiceprintProfile } from '../../shared/speaker-contracts';
import { cosine, normalizeVoiceprint, voiceprintRevision, voiceprintThreshold, type VoiceprintVector } from './speaker-timeline';
import type { SpeechEngine } from './engine';

type StoredVoiceprint = VoiceprintProfile & VoiceprintVector;
type Enrollment = { id: VoiceprintEnrollment['id']; name: string; samples: number[][] };

function displayName(id: VoiceprintEnrollment['id'], value: unknown): string {
  if (typeof value !== 'string') throw new Error('声纹名称无效。');
  const name = value.trim();
  if (id !== 'self' && !name) throw new Error('请输入声纹的显示名称。');
  return name;
}

export class SpeakerSession {
  private profiles: Map<VoiceprintId, StoredVoiceprint>;
  private enrollment?: Enrollment;
  private session?: { id: string; mode: SpeakerCapture; processing: boolean };

  constructor(private readonly speech: SpeechEngine, private readonly path: string) {
    this.profiles = this.loadProfiles();
  }

  get active(): boolean { return !!this.session; }
  get recording(): boolean { return !!this.session && !this.session.processing; }
  get voiceprints(): readonly VoiceprintVector[] { return [...this.profiles.values()]; }

  listProfiles(): VoiceprintProfile[] {
    return Array.from(this.profiles.values(), ({ id, name }) => ({ id, name }));
  }

  begin(mode: SpeakerCapture, target: VoiceprintEnrollment = { id: 'self' }): string | null {
    if (this.session || (mode !== 'enroll' && mode !== 'analyze')) return null;
    if (mode === 'enroll') {
      const id = target?.id;
      if (id !== 'new' && (!isVoiceprintId(id) || (id !== 'self' && !this.profiles.has(id)))) {
        throw new Error('找不到要录入的声纹。');
      }
      const name = target?.id === 'new' ? displayName('new', target.name) : '';
      if (this.enrollment?.id !== id || this.enrollment.name !== name) this.enrollment = { id, name, samples: [] };
    } else this.enrollment = undefined;
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
        const lines = await this.speech.speakers(id, audio, this.profiles.get('self')?.vector ?? null);
        return { type: 'transcript', lines };
      }
      const enrollment = this.enrollment!;
      if (validateSpeechWave(audio) > VOICEPRINT_CLIP_SECONDS) throw new Error('每条声纹样本最长 20 秒。');
      const sample = await this.speech.embedding(id, audio);
      if (this.session !== session) throw new Error('本次录入已取消。');
      if (!sample) throw new Error('人声太短，请重新录制至少 3 秒的清晰人声。');

      if (enrollment.samples.length < VOICEPRINT_SAMPLES) {
        if (enrollment.samples.some(previous => cosine(previous, sample) < voiceprintThreshold)) {
          throw new Error('这段和前面的声音差别较大，请由同一人重新录制。');
        }
        enrollment.samples.push(sample);
        return { type: 'enrollment', saved: false, samples: enrollment.samples.length };
      }

      const merged = normalizeVoiceprint(sample.map((_, i) => enrollment.samples.reduce((sum, clip) => sum + clip[i], 0)));
      if (!merged || cosine(merged, sample) < voiceprintThreshold) {
        throw new Error('验证没有通过，请再换一句话确认。');
      }
      const profileId = enrollment.id === 'new' ? `voiceprint:${randomUUID()}` as const : enrollment.id;
      const name = this.profiles.get(profileId)?.name ?? enrollment.name;
      this.saveProfiles(new Map(this.profiles).set(profileId, { id: profileId, name, vector: merged }));
      this.enrollment = undefined;
      return { type: 'enrollment', saved: true, samples: VOICEPRINT_SAMPLES, profiles: this.listProfiles() };
    } finally {
      if (this.session === session) {
        this.session = undefined;
        this.speech.end(id);
      }
    }
  }

  cancel(keepSamples = false): void {
    if (!keepSamples) this.enrollment = undefined;
    const session = this.session;
    if (!session) return;
    this.session = undefined;
    this.speech.end(session.id);
    if (session.processing) this.speech.close('本次处理已取消。');
  }

  deleteProfile(id: VoiceprintId): VoiceprintProfile[] {
    if (this.session) throw new Error('请先结束本次录音。');
    const remaining = new Map(this.profiles);
    if (!remaining.delete(id)) return this.listProfiles();
    if (remaining.size) this.saveProfiles(remaining);
    else {
      try { rmSync(this.path, { force: true }); }
      catch { throw new Error('无法删除本机声纹，请重试。'); }
      this.profiles = remaining;
    }
    if (this.enrollment?.id === id) this.enrollment = undefined;
    return this.listProfiles();
  }

  renameProfile(id: VoiceprintId, value: unknown): VoiceprintProfile[] {
    const profile = this.profiles.get(id);
    if (!profile) throw new Error('找不到要改名的声纹。');
    const name = displayName(id, value);
    if (name !== profile.name) this.saveProfiles(new Map(this.profiles).set(id, { ...profile, name }));
    return this.listProfiles();
  }

  private loadProfiles(): Map<VoiceprintId, StoredVoiceprint> {
    const profiles = new Map<VoiceprintId, StoredVoiceprint>();
    try {
      const value = JSON.parse(safeStorage.decryptString(readFileSync(this.path)));
      if (value.revision !== voiceprintRevision) return profiles;
      const entries = Array.isArray(value.profiles) ? value.profiles : [{ id: 'self', name: value.name, vector: value.vector }];
      for (const entry of entries) {
        if (!isVoiceprintId(entry?.id) || profiles.has(entry.id) ||
          !Array.isArray(entry.vector) || !entry.vector.every(Number.isFinite)) continue;
        const vector = normalizeVoiceprint(entry.vector);
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        if (vector && (name || entry.id === 'self')) profiles.set(entry.id, { id: entry.id, vector, name });
      }
    } catch { /* No readable profile for this Windows account. */ }
    return profiles;
  }

  private saveProfiles(profiles: Map<VoiceprintId, StoredVoiceprint>): void {
    const temporary = this.path + '.tmp';
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error();
      writeFileSync(temporary, safeStorage.encryptString(JSON.stringify({ revision: voiceprintRevision, profiles: [...profiles.values()] })));
      renameSync(temporary, this.path);
      this.profiles = profiles;
    } catch {
      try { rmSync(temporary, { force: true }); } catch {}
      throw new Error('无法加密保存声纹，请重试。');
    }
  }
}
