import assert from 'node:assert/strict';
import { appendFile, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { meetingAudio } from '../electron/meeting/audio-response';
import { MeetingStore } from '../electron/meeting/store';
import { meetingCut, MeetingSpeakers, mergeMeetingLines } from '../electron/meeting/timeline';
import { MeetingTranscription } from '../electron/meeting/transcription';
import type { MeetingChunk } from '../electron/speech/worker-contract';
import { MEETING_MAX_FRAMES, type MeetingLine } from '../shared/meeting-contracts';
import { encodeSpeechWave, pcmWaveHeader, validateSpeechWave } from '../shared/speech-audio';

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

test('speaker labels are stable across batches and ambiguous matches stay unconfirmed', () => {
  const speakers = new MeetingSpeakers(voice(2));
  assert.equal(speakers.assign(voice(2), true), 'self');
  assert.equal(speakers.assign(voice(0), true), 0);
  assert.equal(speakers.assign(voice(1), true), 1);
  assert.equal(speakers.assign(voice(0), true), 0);
  assert.equal(speakers.assign(voice(2), false), 'unknown');
  const ambiguous = voice(0).map((value, index) => (value + voice(1)[index]) / Math.sqrt(2));
  assert.equal(speakers.assign(ambiguous, true), 'unknown');
  const restarted = new MeetingSpeakers(null);
  restarted.restore(0, voice(0));
  restarted.restore(1, null);
  assert.equal(restarted.assign(voice(0), false), 0);
  assert.equal(restarted.assign(voice(1), false), 2);
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
  const transcription = new MeetingTranscription(store, engine, () => null, () => {
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
