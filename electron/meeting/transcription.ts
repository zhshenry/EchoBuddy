import type { MeetingDetail, MeetingLine, MeetingRecord, MeetingSource, MeetingSpeaker } from '../../shared/meeting-contracts';
import { pcmWaveHeader } from '../../shared/speech-audio';
import { SPEECH_SAMPLE_RATE as rate } from '../../shared/speech-contracts';
import type { SpeechEngine } from '../speech/engine';
import { minimumMeetingVoiceSamples, type VoiceprintVector } from '../speech/speaker-timeline';
import type { MeetingCandidate, MeetingChunk } from '../speech/worker-contract';
import { frameMs, type MeetingStore, type MeetingUpdate } from './store';
import { meetingCut, MeetingSpeakers, mergeMeetingLines } from './timeline';

const chunkFrames = 30 * rate;
const contextFrames = 2 * rate;
const toFrame = (ms: number) => Math.round(ms / 1000 * rate);
type Inference = Pick<SpeechEngine, 'begin' | 'end' | 'close' | 'embedding' | 'meetingChunk'>;
type SourceChunk = MeetingChunk & { source: MeetingSource };

export class MeetingTranscription {
  private processing?: { id: string; done: Promise<void> };
  private shuttingDown = false;
  private readonly retrying = new Set<string>();
  private readonly deleting = new Set<string>();

  constructor(
    private readonly store: MeetingStore,
    private readonly engine: Inference,
    private readonly voiceprints: () => readonly VoiceprintVector[],
    private readonly publish: () => void,
  ) {}

  start(): void {
    if (this.processing || this.shuttingDown) return;
    const record = this.store.list().find(item => item.status === 'queued' && !this.deleting.has(item.id));
    if (!record) return;
    const done = this.process(record).catch(error => {
      console.error('EchoBuddy could not save transcription progress', error);
    }).then(() => {
      this.processing = undefined;
      // A write failure may have left this record queued. Wait for a new request or app restart.
      if (this.store.get(record.id)?.status !== 'queued') this.start();
    });
    this.processing = { id: record.id, done };
  }

  close(): void {
    this.shuttingDown = true;
    this.engine.close();
  }

  async detail(id: string): Promise<MeetingDetail | null> {
    const record = this.store.get(id);
    if (!record?.durationMs) return null;
    const batches = await this.store.batches(id);
    const lines = batches.flatMap(batch => batch.lines).sort((a, b) => a.startMs - b.startMs);
    return { record, lines };
  }

  async retry(id: string): Promise<void> {
    const record = this.store.get(id);
    if (!record?.durationMs || record.status !== 'failed' || this.retrying.has(id) || this.deleting.has(id)) return;
    this.retrying.add(id);
    try {
      await this.save(id, { status: 'queued', error: '' });
      this.start();
    } finally { this.retrying.delete(id); }
  }

  async trash(id: string, moveToTrash: (path: string) => Promise<void>): Promise<void> {
    if (this.deleting.has(id)) throw new Error('正在删除这场会议。');
    this.deleting.add(id);
    try {
      const processing = this.processing;
      if (processing?.id === id) {
        this.engine.end(id);
        this.engine.close();
        await processing.done;
        // A failed move can resume from the last committed batch.
        if (this.store.get(id)?.status === 'transcribing') await this.save(id, { status: 'queued' });
      }
      await this.store.trash(id, moveToTrash);
    } finally {
      this.deleting.delete(id);
      this.start();
    }
  }

  private async save(id: string, changes: MeetingUpdate): Promise<void> {
    await this.store.update(id, changes);
    this.publish();
  }

  private async process(record: MeetingRecord): Promise<void> {
    const { id, language } = record;
    const interrupted = () => this.shuttingDown || this.deleting.has(id);
    this.engine.begin(id);
    try {
      const batches = await this.store.batches(id);
      const total = await this.store.frameCount(record);
      if (interrupted()) return;
      let start = batches.at(-1)?.endFrame ?? 0;
      await this.save(id, { status: 'transcribing', processedMs: frameMs(start), error: '' });
      const speakers = new MeetingSpeakers(this.voiceprints());
      if (start) await this.restoreSpeakers(record, speakers, batches.flatMap(batch => batch.lines));
      let recent = batches.slice(-2).flatMap(batch => batch.lines);
      while (start < total && !interrupted()) {
        const readFrom = Math.max(0, start - contextFrames);
        const readUntil = Math.min(total, start + chunkFrames + contextFrames);
        const sources: SourceChunk[] = [];
        for (const source of record.sources) {
          const audio = await this.store.readWave(id, source, readFrom, readUntil - readFrom);
          if (interrupted()) return;
          sources.push({ source, ...await this.engine.meetingChunk(id, audio, language) });
          if (interrupted()) return;
        }
        const offsetMs = frameMs(readFrom);
        const end = readUntil === total ? total : readFrom + toFrame(meetingCut(
          sources.flatMap(source => source.lines), frameMs(start + chunkFrames - readFrom),
        ));
        const lines = this.labelChunk(id, sources, speakers, recent, offsetMs, frameMs(start), frameMs(end), end === total);
        await this.store.append(id, { startFrame: start, endFrame: end, lines });
        await this.save(id, { processedMs: Math.min(record.durationMs, frameMs(end)) });
        start = end;
        recent = [...recent, ...lines].filter(line => line.endMs >= frameMs(end - 4 * contextFrames));
      }
      if (!interrupted()) await this.save(id, { status: 'ready', processedMs: record.durationMs });
    } catch (error) {
      if (!interrupted()) {
        console.error('EchoBuddy meeting transcription failed', error);
        await this.save(id, { status: 'failed', error: error instanceof Error && /[\u3400-\u9fff]/.test(error.message)
          ? error.message : '会议转写失败，请重试。' });
      }
    } finally {
      if (!this.shuttingDown) this.engine.end(id);
    }
  }

  private labelChunk(id: string, sources: SourceChunk[], speakers: MeetingSpeakers,
    recent: MeetingLine[], offset: number, from: number, to: number, final: boolean): MeetingLine[] {
    const bindings = new Map<string, { chunk: SourceChunk; candidate: MeetingCandidate }>();
    const lines = sources.flatMap(chunk => chunk.lines.flatMap((candidate, index) => {
      const startMs = offset + candidate.startMs, endMs = offset + candidate.endMs;
      const midpoint = (startMs + endMs) / 2;
      if (midpoint < from || (!final && midpoint >= to)) return [];
      const key = id + ':' + from + ':' + chunk.source + ':' + index;
      bindings.set(key, { chunk, candidate });
      const recognition = candidate.recognition;
      const line: MeetingLine = { id: key, startMs, endMs, speaker: 'unknown', source: chunk.source, text: candidate.text,
        recognition: recognition && { ...recognition, tokenTimesMs: recognition.tokenTimesMs?.map(time => time + offset) } };
      return [line];
    }));
    const assigned = new Map<string, MeetingSpeaker>();
    return mergeMeetingLines(lines, recent).map(line => {
      const { chunk, candidate } = bindings.get(line.id)!;
      const voice = chunk.voices.find(item => item.group === candidate.group);
      if (!voice) return line;
      const key = chunk.source + ':' + voice.group;
      let label = assigned.get(key);
      if (label === undefined) {
        label = speakers.assign(voice, chunk.voices);
        assigned.set(key, label);
      }
      return { ...line, speaker: label };
    });
  }

  private async restoreSpeakers(record: MeetingRecord, speakers: MeetingSpeakers, lines: MeetingLine[]): Promise<void> {
    const samples = new Map<number, MeetingLine[]>();
    for (const line of lines) {
      if (typeof line.speaker !== 'number') continue;
      const clips = samples.get(line.speaker) ?? [];
      clips.push(line);
      samples.set(line.speaker, clips);
    }
    const total = await this.store.frameCount(record);
    for (const [speaker, clips] of samples) {
      if (this.shuttingDown || this.deleting.has(record.id)) return;
      const longest = clips.sort((a, b) => (b.endMs - b.startMs) - (a.endMs - a.startMs)).slice(0, 4);
      const pcm: Uint8Array[] = [];
      let frames = 0;
      for (const clip of longest) {
        const start = toFrame(clip.startMs), count = Math.min(total - start, toFrame(clip.endMs) - start, 12 * rate - frames);
        if (count <= 0) continue;
        const wave = await this.store.readWave(record.id, clip.source, start, count);
        pcm.push(wave.subarray(44));
        frames += count;
      }
      const audio = Buffer.concat([pcmWaveHeader(frames), ...pcm]);
      const embedding = frames >= minimumMeetingVoiceSamples ? await this.engine.embedding(record.id, audio, true) : null;
      speakers.restore(speaker, embedding);
    }
  }
}
