import assert from 'node:assert/strict';
import { appendFile, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { meetingAudio } from '../electron/meeting/audio-response';
import { MeetingStore } from '../electron/meeting/store';
import { meetingCut, MeetingSpeakers, mergeMeetingLines } from '../electron/meeting/timeline';
import { MeetingTranscription } from '../electron/meeting/transcription';
import type { MeetingChunk } from '../electron/speech/worker-contract';
import { MEETING_MAX_FRAMES, type MeetingLine } from '../shared/meeting-contracts';
import { encodeSpeechWave, pcmWaveHeader, validateSpeechWave } from '../shared/speech-audio';

const guest = 'voiceprint:bee50cc0-508d-4b02-ac5e-ecc4328975ed' as const;
const secondGuest = 'voiceprint:acf7aa8c-ad61-4b0e-90db-af0c593ffed1' as const;

async function library(t: TestContext) {
  const root = await mkdtemp(resolve('.echobuddy-meeting-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new MeetingStore(root) };
}

test('reopening a recording with stale headers repairs both tracks on the common time line', async t => {
  const { root, store } = await library(t);
  const record = await store.begin(['microphone', 'system'], 'auto');
  await writeFile(store.track(record.id, 'microphone'), Buffer.concat([pcmWaveHeader(0), Buffer.alloc(64001, 10)]));
  await writeFile(store.track(record.id, 'system'), Buffer.concat([pcmWaveHeader(0), Buffer.alloc(32000, 4)]));
  const recovered = new MeetingStore(root);
  await recovered.load();
  const saved = recovered.list()[0];
  assert.equal(saved.status, 'queued');
  assert.equal(saved.durationMs, 2000);
  assert.match(saved.warning, /上次录音中断/);
  const system = await readFile(recovered.track(saved.id, 'system'));
  assert.equal(validateSpeechWave(system), 2);
  assert.equal(system[32043], 4);
  assert.equal(system[32044], 0);
});

test('renaming a meeting and saving transcription progress preserve both changes on reopen', async t => {
  const { root, store } = await library(t);
  const base = await store.begin(['microphone'], 'auto');
  const record = await store.save({ ...base, status: 'transcribing', durationMs: 4000 });
  await Promise.all([
    store.update(record.id, { title: '项目例会' }),
    store.update(record.id, { status: 'ready', processedMs: 4000 }),
  ]);

  const reopened = new MeetingStore(root);
  await reopened.load();
  assert.deepEqual(reopened.list(), [{ ...record, title: '项目例会', status: 'ready', processedMs: 4000 }]);
});

test('speaker names survive reopen and concurrent transcription updates without rewriting speaker IDs', async t => {
  const { root, store } = await library(t);
  const record = await store.save({ ...await store.begin(['microphone'], 'auto'), status: 'transcribing', durationMs: 4000 });
  const other = await store.save({ ...await store.begin(['microphone'], 'auto'), status: 'ready', durationMs: 1000 });
  const line: MeetingLine = { id: 'first', startMs: 0, endMs: 1000, text: '周会开始', source: 'microphone', speaker: 4 };
  const first = { startFrame: 0, endFrame: 16000, lines: [line, { ...line, id: 'guest', speaker: guest }] };
  await store.append(record.id, first);

  await Promise.all([
    store.renameSpeaker(record.id, 4, '  周宁  '),
    store.renameSpeaker(record.id, 'self', '主持人'),
    store.renameSpeaker(record.id, guest, '嘉宾'),
    store.update(record.id, { status: 'ready', processedMs: 4000 }),
  ]);
  await assert.rejects(store.renameSpeaker(record.id, 'unknown', '周宁'), /无效/);
  await assert.rejects(store.renameSpeaker(record.id, 4, '   '), /不能为空/);

  const reopened = new MeetingStore(root);
  await reopened.load();
  assert.deepEqual(reopened.get(record.id), {
    ...record, status: 'ready', processedMs: 4000, speakerNames: { 4: '周宁', self: '主持人', [guest]: '嘉宾' },
  });
  assert.deepEqual(reopened.get(other.id), other);
  assert.deepEqual(await reopened.batches(record.id), [first]);
  await reopened.renameSpeaker(record.id, 4, null);
  const restored = new MeetingStore(root);
  await restored.load();
  assert.deepEqual(restored.get(record.id)?.speakerNames, { self: '主持人', [guest]: '嘉宾' });
});

test('a meeting leaves the library only after its directory is moved to the recycle bin', async t => {
  const { root, store } = await library(t);
  const record = await store.save({ ...await store.begin(['microphone', 'system'], 'auto'), status: 'ready', durationMs: 1000 });
  const other = await store.save({ ...await store.begin(['microphone'], 'auto'), status: 'ready', durationMs: 1000 });
  for (const source of record.sources) await writeFile(store.track(record.id, source), encodeSpeechWave(new Float32Array(16000)));
  await store.append(record.id, { startFrame: 0, endFrame: 16000, lines: [] });

  await assert.rejects(store.trash(record.id, async () => { throw new Error('Recycle Bin unavailable'); }), /unavailable/);
  assert.equal(store.get(record.id), record);
  const recycled = join(root, 'recycled');
  await Promise.all([
    store.update(record.id, { title: '验收会议' }),
    store.trash(record.id, async path => {
      assert.equal(path, store.directory(record.id));
      await rename(path, recycled);
    }),
  ]);

  assert.equal(store.audioPath(record.id, 'microphone'), null);
  assert.equal(JSON.parse(await readFile(join(recycled, 'meeting.json'), 'utf8')).title, '验收会议');
  for (const source of record.sources) assert.equal(validateSpeechWave(await readFile(join(recycled, source + '.wav'))), 1);
  assert.match(await readFile(join(recycled, 'transcript.jsonl'), 'utf8'), /"endFrame":16000/);
  const reopened = new MeetingStore(root);
  await reopened.load();
  assert.deepEqual(reopened.list(), [other]);
});

test('deleting a meeting being transcribed stops its worker and continues the remaining queue', { timeout: 5000 }, async t => {
  const { root, store } = await library(t);
  const current = await store.begin(['microphone'], 'auto');
  const next = await store.begin(['microphone'], 'auto');
  for (const record of [current, next]) {
    await writeFile(store.track(record.id, 'microphone'), encodeSpeechWave(new Float32Array(16000)));
    await store.finish(record, '');
  }
  await store.save({ ...store.get(next.id)!, createdAt: current.createdAt - 1000 });

  let requestStarted!: () => void, complete!: () => void, cancelChunk!: (error: Error) => void;
  const started = new Promise<void>(resolve => { requestStarted = resolve; });
  const ready = new Promise<void>(resolve => { complete = resolve; });
  let stopped = false;
  const engine = {
    begin() {}, end() {}, async embedding() { return null; },
    close() { stopped = true; cancelChunk(new Error('Worker stopped')); },
    async meetingChunk(id: string): Promise<MeetingChunk> {
      if (id !== current.id) return { lines: [], voices: [] };
      return new Promise((_resolve, reject) => {
        cancelChunk = reject;
        requestStarted();
      });
    },
  };
  const transcription = new MeetingTranscription(store, engine, () => [], () => {
    if (store.get(next.id)?.status === 'ready') complete();
  });
  transcription.start();
  await started;
  assert.equal(store.get(current.id)?.status, 'transcribing');
  await transcription.trash(current.id, async path => {
    assert.equal(stopped, true);
    await rename(path, join(root, 'recycled'));
  });
  await ready;
  assert.equal(store.get(current.id), undefined);
  assert.equal(store.get(next.id)?.status, 'ready');
});

test('a two-hour recording remains streamable with bounded HTTP byte ranges', async t => {
  const { store } = await library(t);
  const record = await store.begin(['system'], 'auto');
  const path = store.track(record.id, 'system'), size = 44 + 2 * MEETING_MAX_FRAMES;
  const file = await open(path, 'w');
  try { await file.writeFile(pcmWaveHeader(0)); await file.truncate(size); }
  finally { await file.close(); }
  const saved = await store.finish(record, '');
  assert.equal(saved.durationMs, 7200000);
  const request = (range: string, method = 'GET') => new Request('echobuddy://app/meeting-audio', { method, headers: { Range: range } });
  const header = await meetingAudio(request('bytes=0-43'), path);
  assert.equal(header.status, 206);
  assert.equal(header.headers.get('content-range'), 'bytes 0-43/' + size);
  assert.equal(Buffer.from(await header.arrayBuffer()).readUInt32LE(40), 2 * MEETING_MAX_FRAMES);
  const tail = await meetingAudio(request('bytes=-20'), path);
  assert.equal((await tail.arrayBuffer()).byteLength, 20);
  const head = await meetingAudio(request('bytes=44-', 'HEAD'), path);
  assert.equal(head.headers.get('content-length'), String(size - 44));
  assert.equal(head.body, null);
  assert.equal((await meetingAudio(request('bytes=' + size + '-'), path)).status, 416);
});

const voice = (index: number) => Array.from({ length: 192 }, (_, i) => i === index ? 1 : 0);
const line = (properties: Partial<MeetingLine> = {}): MeetingLine => ({
  id: 'clip', startMs: 0, endMs: 4000, text: '我们先对一下今天的任务。', speaker: 'unknown', source: 'system', ...properties,
});

test('one recording recognizes several enrolled speakers and leaves close or short matches unconfirmed', { timeout: 5000 }, async t => {
  const { store } = await library(t);
  const base = await store.begin(['microphone'], 'auto');
  await writeFile(store.track(base.id, 'microphone'), encodeSpeechWave(new Float32Array(35 * 16000)));
  const record = await store.finish(base, '');
  const closeMatch = voice(1).map((value, index) => (value + voice(2)[index]) / Math.sqrt(2));
  let chunks = 0;
  const engine = {
    begin() {}, end() {}, close() {}, async embedding() { return null; },
    async meetingChunk(): Promise<MeetingChunk> {
      if (++chunks === 2) return {
        lines: [{ startMs: 3000, endMs: 6800, group: 0, text: '继续讨论。' }],
        voices: [{ group: 0, vector: voice(1), samples: 60000 }],
      };
      const vectors = [voice(0), voice(1), voice(2), closeMatch, voice(3), voice(1)];
      return {
        lines: vectors.map((_, group) => ({ group, startMs: group * 4000, endMs: group * 4000 + 3500, text: '发言 ' + group })),
        voices: vectors.map((vector, group) => ({ group, vector, samples: group === 5 ? 20000 : 54000 })),
      };
    },
  };
  let completed!: () => void;
  const ready = new Promise<void>(resolve => { completed = resolve; });
  const transcription = new MeetingTranscription(store, engine, () => [
    { id: 'self', vector: voice(0) }, { id: guest, vector: voice(1) }, { id: secondGuest, vector: voice(2) },
  ], () => { if (store.get(record.id)?.status === 'ready') completed(); });
  transcription.start();
  await ready;
  assert.deepEqual((await transcription.detail(record.id))?.lines.map(item => item.speaker),
    ['self', guest, secondGuest, 'unknown', 0, 'unknown', guest]);
});

test('speaker labels are stable across batches and ambiguous matches stay unconfirmed', () => {
  const clip = (vector: number[], samples = 48000) => ({ group: 0, vector, samples });
  const speakers = new MeetingSpeakers([{ id: 'self', vector: voice(2) }]);
  const own = clip(voice(2));
  assert.equal(speakers.assign(own), 'self');
  assert.equal(speakers.assign(clip(voice(0))), 0);
  assert.equal(speakers.assign(clip(voice(1))), 1);
  assert.equal(speakers.assign(clip(voice(0))), 0);
  assert.equal(speakers.assign(clip(voice(2), 20000)), 'unknown');
  assert.equal(speakers.assign(own, [own, { ...own, group: 1 }]), 'unknown');
  const ambiguous = voice(0).map((value, index) => (value + voice(1)[index]) / Math.sqrt(2));
  assert.equal(speakers.assign(clip(ambiguous)), 'unknown');
  const restarted = new MeetingSpeakers([]);
  restarted.restore(0, voice(0));
  restarted.restore(1, null);
  assert.equal(restarted.assign(clip(voice(0))), 0);
  assert.equal(restarted.assign(clip(voice(1))), 2);
});

test('echoes on aligned tracks are merged without removing a later repeated sentence', () => {
  const primary = line({ id: 'computer' }), echo = line({ id: 'mic', source: 'microphone', startMs: 100, endMs: 3900 });
  const repeat = line({ id: 'repeat', startMs: 6000, endMs: 8000 });
  assert.deepEqual(mergeMeetingLines([echo, repeat, primary], []), [primary, repeat]);
  assert.deepEqual(mergeMeetingLines([repeat, echo], [primary]), [repeat]);
  assert.equal(meetingCut([{ startMs: 28000, endMs: 31500 }], 30000), 27850);
  assert.equal(meetingCut([{ startMs: 28000, endMs: 31500 }, { startMs: 25500, endMs: 31600 }], 30000), 25350);
});

test('a failed transcription retries from the last committed dual-source batch after a torn append', async t => {
  const { store } = await library(t);
  const base = await store.begin(['microphone', 'system'], 'en');
  const wave = encodeSpeechWave(new Float32Array(35 * 16000));
  for (const source of base.sources) await writeFile(store.track(base.id, source), wave);
  const record = await store.finish(base, '');
  await store.save({ ...record, processedMs: 30000, status: 'failed' });
  await store.append(record.id, { startFrame: 0, endFrame: 30 * 16000, lines: [line({ id: 'prior' })] });
  await appendFile(join(store.directory(record.id), 'transcript.jsonl'), '\n{"startFrame":480000,');
  let calls = 0;
  let completed!: () => void;
  const ready = new Promise<void>(resolve => { completed = resolve; });
  const engine = {
    begin() {}, end() {}, close() {}, async embedding() { return null; },
    async meetingChunk(_id: string, audio: Uint8Array): Promise<MeetingChunk> {
      assert.equal(validateSpeechWave(audio), 7);
      calls++;
      const lines = calls === 2 ? [{ startMs: 3000, endMs: 5000, group: 4, text: 'End.', recognition: { tokenTimesMs: [3000] } }] : [];
      return { lines, voices: [] };
    },
  };
  const transcription = new MeetingTranscription(store, engine, () => [], () => {
    if (store.get(record.id)?.status === 'ready') completed();
  });
  await transcription.retry(record.id);
  await ready;
  assert.equal(calls, 2);
  const detail = await transcription.detail(record.id);
  assert.equal(detail?.lines[0].id, 'prior');
  assert.equal(detail?.lines[1].startMs, 31000);
  assert.deepEqual(detail?.lines[1].recognition?.tokenTimesMs, [31000]);
  assert.equal(detail?.record.processedMs, 35000);
  assert.equal((await store.batches(record.id)).length, 2);
});
