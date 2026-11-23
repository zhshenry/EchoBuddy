import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { MEETING_MAX_FRAMES, MEETING_SOURCES, type MeetingLine, type MeetingRecord, type MeetingSource, type MeetingSpeaker, type MeetingStatus } from '../../shared/meeting-contracts';
import { pcmWaveHeader } from '../../shared/speech-audio';
import { isVoiceprintId } from '../../shared/speaker-contracts';
import { SPEECH_LANGUAGES, SPEECH_SAMPLE_RATE as rate, type SpeechLanguage } from '../../shared/speech-contracts';

export const meetingId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const frameMs = (frames: number) => Math.round(frames / rate * 1000);
const waveHeaderSize = 44;
const statuses: MeetingStatus[] = ['recording', 'queued', 'transcribing', 'ready', 'failed'];
const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export interface MeetingBatch { startFrame: number; endFrame: number; lines: MeetingLine[]; }
export type MeetingUpdate = Partial<Pick<MeetingRecord, 'title' | 'status' | 'processedMs' | 'error'>>;

export class MeetingStore {
  private readonly records = new Map<string, MeetingRecord>();
  private readonly writes = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string) {}

  directory(id: string): string {
    if (!meetingId.test(id)) throw new Error('会议记录无效。');
    return join(this.root, id);
  }

  track(id: string, source: MeetingSource): string {
    if (!MEETING_SOURCES.includes(source)) throw new Error('录音来源无效。');
    return join(this.directory(id), source + '.wav');
  }

  audioPath(id: string, source: MeetingSource): string | null {
    const record = this.get(id);
    return record?.durationMs && record.sources.includes(source) ? this.track(id, source) : null;
  }

  get(id: string): MeetingRecord | undefined { return this.records.get(id); }

  list(): MeetingRecord[] {
    return [...this.records.values()].filter(record => record.durationMs > 0).sort((a, b) => b.createdAt - a.createdAt);
  }

  async load(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !meetingId.test(entry.name)) continue;
      try {
        const record: MeetingRecord = JSON.parse(await readFile(join(this.directory(entry.name), 'meeting.json'), 'utf8'));
        if (record.id !== entry.name || !Array.isArray(record.sources) || !record.sources.length ||
            record.sources.some(source => !MEETING_SOURCES.includes(source)) || !statuses.includes(record.status) ||
            !Number.isFinite(record.durationMs) || !Number.isFinite(record.createdAt) || typeof record.title !== 'string') continue;
        if (!SPEECH_LANGUAGES.includes(record.language)) record.language = 'auto';
        if (record.status === 'recording') {
          await this.finish(record, '上次录音中断，已保留录到的部分。');
        } else if (record.status === 'transcribing') {
          await this.save({ ...record, status: 'queued' });
        } else this.records.set(record.id, record);
      } catch (error) {
        console.warn('Could not recover an EchoBuddy meeting', entry.name, error);
      }
    }
  }

  async begin(sources: MeetingSource[], language: SpeechLanguage): Promise<MeetingRecord> {
    const createdAt = Date.now(), id = randomUUID();
    const record: MeetingRecord = {
      id, title: '会议录音 ' + time.format(createdAt), createdAt, sources, language, durationMs: 0, processedMs: 0,
      status: 'recording', warning: '', error: '',
    };
    await mkdir(this.directory(id), { recursive: true });
    return this.save(record);
  }

  save(record: MeetingRecord): Promise<MeetingRecord> {
    return this.enqueueWrite(record.id, () => this.write(record));
  }

  update(id: string, changes: MeetingUpdate): Promise<MeetingRecord> {
    return this.enqueueWrite(id, () => {
      const record = this.get(id);
      if (!record) throw new Error('找不到这场会议。');
      return this.write({ ...record, ...changes });
    });
  }

  renameSpeaker(id: string, speaker: MeetingSpeaker, name: string | null): Promise<MeetingRecord> {
    return this.enqueueWrite(id, () => {
      const record = this.get(id);
      if (!record?.durationMs) throw new Error('找不到这场会议。');
      if (!isVoiceprintId(speaker) && (typeof speaker !== 'number' || !Number.isSafeInteger(speaker) || speaker < 0)) {
        throw new Error('说话人无效。');
      }
      if (name !== null && (typeof name !== 'string' || !name.trim())) throw new Error('说话人名称不能为空。');
      const speakerNames = { ...record.speakerNames };
      if (name === null) delete speakerNames[speaker];
      else speakerNames[speaker] = name.trim();
      return this.write({ ...record, speakerNames });
    });
  }

  trash(id: string, moveToTrash: (path: string) => Promise<void>): Promise<void> {
    return this.enqueueWrite(id, async () => {
      const record = this.get(id);
      if (!record) return;
      if (!record.durationMs || record.status === 'recording') throw new Error('录音保存后可删除。');
      await moveToTrash(this.directory(id));
      this.records.delete(id);
    });
  }

  private async enqueueWrite<T>(id: string, action: () => Promise<T>): Promise<T> {
    const write = Promise.resolve(this.writes.get(id)).catch(() => {}).then(action);
    this.writes.set(id, write);
    try { return await write; }
    finally { if (this.writes.get(id) === write) this.writes.delete(id); }
  }

  private async write(record: MeetingRecord): Promise<MeetingRecord> {
    const path = join(this.directory(record.id), 'meeting.json');
    const handle = await open(path + '.tmp', 'w');
    try {
      await handle.writeFile(JSON.stringify(record), 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await rename(path + '.tmp', path);
    this.records.set(record.id, record);
    return record;
  }

  /** Recover the PCM lengths even when the WAV header was last written before the final batch. */
  async finish(record: MeetingRecord, warning: string): Promise<MeetingRecord> {
    const files: { source: MeetingSource; handle: FileHandle; frames: number }[] = [];
    try {
      for (const source of record.sources) {
        const handle = await openForRecovery(this.track(record.id, source));
        if (handle) {
          const file = { source, handle, frames: 0 };
          files.push(file);
          const size = (await handle.stat()).size;
          file.frames = Math.max(0, Math.min(MEETING_MAX_FRAMES, Math.floor((size - waveHeaderSize) / 2)));
        }
      }
      const frames = Math.max(0, ...files.map(file => file.frames));
      if (frames) {
        for (const { handle } of files) {
          await handle.truncate(waveHeaderSize + 2 * frames);
          await handle.writeFile(pcmWaveHeader(frames));
          await handle.sync();
        }
      }
      return await this.save({
        ...record, warning, sources: files.length ? files.map(file => file.source) : record.sources,
        status: frames ? 'queued' : 'failed', durationMs: frames ? Math.max(1, frameMs(frames)) : 0,
      });
    } finally {
      await Promise.all(files.map(file => file.handle.close()));
    }
  }

  async readWave(id: string, source: MeetingSource, start: number, count: number): Promise<Uint8Array> {
    const handle = await open(this.track(id, source), 'r');
    try {
      const bytes = Buffer.alloc(waveHeaderSize + count * 2);
      bytes.set(pcmWaveHeader(count));
      let offset = waveHeaderSize;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, start * 2 + offset);
        if (!bytesRead) throw new Error('录音文件不完整。');
        offset += bytesRead;
      }
      return bytes;
    } finally { await handle.close(); }
  }

  async frameCount(record: MeetingRecord): Promise<number> {
    const { size } = await stat(this.track(record.id, record.sources[0]));
    return Math.floor((size - waveHeaderSize) / 2);
  }

  async batches(id: string): Promise<MeetingBatch[]> {
    let text: string;
    try { text = await readFile(join(this.directory(id), 'transcript.jsonl'), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const batches: MeetingBatch[] = [];
    let nextFrame = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const batch: MeetingBatch = JSON.parse(line);
        if (batch.startFrame !== nextFrame || !Number.isInteger(batch.endFrame) ||
            batch.endFrame <= nextFrame || batch.endFrame > MEETING_MAX_FRAMES || !Array.isArray(batch.lines)) continue;
        batches.push(batch);
        nextFrame = batch.endFrame;
      } catch { /* A crash can leave one partial batch. */ }
    }
    return batches;
  }

  async append(id: string, batch: MeetingBatch): Promise<void> {
    const handle = await open(join(this.directory(id), 'transcript.jsonl'), 'a');
    try {
      await handle.writeFile('\n' + JSON.stringify(batch) + '\n');
      await handle.sync();
    } finally { await handle.close(); }
  }
}

async function openForRecovery(path: string): Promise<FileHandle | null> {
  for (let attempt = 0; ; attempt++) {
    try { return await open(path, 'r+'); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      if (attempt === 10 || !['EBUSY', 'EPERM', 'EACCES'].includes(code ?? '')) throw error;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
}
