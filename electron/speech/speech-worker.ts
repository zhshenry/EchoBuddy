// SenseVoice/Silero pipeline adapted from DeepSeek Harness rc.2 (MIT).
// Attribution and the separate model/runtime licenses ship in assets/speech/licenses.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { MeetingRecognition } from '../../shared/meeting-contracts';
import { decodeSpeechWave, validateSpeechWave } from '../../shared/speech-audio';
import { VOICEPRINT_MIN_VOICE_SECONDS } from '../../shared/speaker-contracts';
import { SPEECH_SAMPLE_RATE as rate } from '../../shared/speech-contracts';
import {
  buildSpeakerSpans, cosine, labelSpeakerGroups, meetingSpeakerForUtterance, minimumMeetingVoiceSamples,
  normalizeVoiceprint, type DiarizedSegment, type SpeakerSpan,
} from './speaker-timeline';
import type { MeetingCandidate, MeetingChunk, WorkerRequest, WorkerResult } from './worker-contract';

const port = process.parentPort!;
const directory = process.argv[2];
const minimumVoice = VOICEPRINT_MIN_VOICE_SECONDS * rate;
const embeddingModel = 'speaker-embedding.onnx';
const segmentationModel = 'speaker-segmentation.onnx';
const ms = (sample: number) => Math.round(sample / rate * 1000);
type TimedSpeech = { start: number; end: number };
type Recognition = { text: string; lang?: string; emotion?: string; event?: string; tokens?: string[]; timestamps?: number[] };

async function initialize(): Promise<void> {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as { files: { name: string; bytes: number; sha256: string }[] };
  async function verifyAsset(name: string): Promise<void> {
    const asset = manifest.files.find(file => file.name === name), path = join(directory, name);
    if (!asset || (await stat(path)).size !== asset.bytes) throw new Error('语音资源缺失或损坏，请修复安装。');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest('hex') !== asset.sha256) throw new Error('语音资源校验失败，请修复安装。');
  }
  for (const name of ['model.int8.onnx', 'tokens.txt', 'silero_vad.onnx']) await verifyAsset(name);
  const sherpa = require('sherpa-onnx-node');
  const config = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: join(directory, 'model.int8.onnx'), language: 'auto', useInverseTextNormalization: 1 },
      tokens: join(directory, 'tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0,
    },
  };
  const recognizer = new sherpa.OfflineRecognizer(config);
  const vad = new sherpa.Vad({
    sileroVad: { model: join(directory, 'silero_vad.onnx'), threshold: .5, minSilenceDuration: .5, minSpeechDuration: .25, maxSpeechDuration: 30, windowSize: 512 },
    sampleRate: 16000, numThreads: 2, provider: 'cpu', debug: 0,
  }, 32);

  function voiced(samples: Float32Array, onSpeech: (start: number, speech: Float32Array) => void): void {
    vad.reset();
    const drain = () => {
      while (!vad.isEmpty()) {
        const segment = vad.front(false);
        onSpeech(segment.start, segment.samples);
        vad.pop();
      }
    };
    for (let offset = 0; offset < samples.length; offset += 512) { vad.acceptWaveform(samples.subarray(offset, offset + 512)); drain(); }
    vad.flush(); drain();
  }

  function decode(speech: Float32Array): Recognition {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: rate, samples: speech });
    recognizer.decode(stream);
    return recognizer.getResult(stream);
  }
  const recognize = (samples: Float32Array) => decode(samples).text.trim();

  const embeddingConfig = { model: join(directory, embeddingModel), numThreads: 2, provider: 'cpu', debug: 0 };
  let extractor: {
    createStream(): { acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void; inputFinished(): void };
    isReady(stream: unknown): boolean;
    compute(stream: unknown, enableExternalBuffer: boolean): Float32Array;
  } | undefined;
  type Diarizer = { process(samples: Float32Array): DiarizedSegment[] };
  let diarizer: Diarizer | undefined, meetingDiarizer: Diarizer | undefined;

  async function prepareSpeakerModels(mode: 'embedding' | 'speakers' | 'meeting'): Promise<void> {
    try {
      if (!extractor) {
        await verifyAsset(embeddingModel);
        extractor = new sherpa.SpeakerEmbeddingExtractor(embeddingConfig);
      }
      if ((mode === 'speakers' && !diarizer) || (mode === 'meeting' && !meetingDiarizer)) {
        await verifyAsset(segmentationModel);
        const model: Diarizer = new sherpa.OfflineSpeakerDiarization({
          segmentation: { pyannote: { model: join(directory, segmentationModel) }, numThreads: 2, provider: 'cpu' },
          embedding: embeddingConfig, clustering: { numClusters: mode === 'meeting' ? -1 : 2, threshold: .65 },
          minDurationOn: .2, minDurationOff: .35,
        });
        if (mode === 'meeting') meetingDiarizer = model;
        else diarizer = model;
      }
    } catch {
      throw new Error('无法加载说话人模型，请修复安装后重试。');
    }
  }

  function embed(clips: Float32Array[], minimumSamples = minimumVoice): number[] | null {
    const sampleCount = clips.reduce((total, clip) => total + clip.length, 0);
    if (sampleCount < minimumSamples || !extractor) return null;
    const stream = extractor.createStream();
    let remaining = 16 * rate;
    for (const clip of clips) {
      const samples = clip.subarray(0, remaining);
      stream.acceptWaveform({ sampleRate: rate, samples });
      remaining -= samples.length;
      if (!remaining) break;
    }
    stream.inputFinished();
    return extractor.isReady(stream) ? normalizeVoiceprint(extractor.compute(stream, false)) : null;
  }

  function findSpeech(samples: Float32Array): TimedSpeech[] {
    const speech: TimedSpeech[] = [];
    voiced(samples, (start, clip) => speech.push({ start, end: start + clip.length }));
    return speech;
  }

  function alignSpeech(spans: SpeakerSpan[], speech: TimedSpeech[]) {
    return spans.map(span => ({
      ...span,
      parts: speech.map(({ start, end }) => ({ start: Math.max(span.start, start), end: Math.min(span.end, end) }))
        // Very small alignment slivers tend to yield spurious punctuation and filler.
        .filter(({ start, end }) => end - start >= rate * .25),
    })).filter(span => span.parts.length);
  }

  function analyze(samples: Float32Array, segments: DiarizedSegment[], voiceprint: number[] | null) {
    const spans = alignSpeech(buildSpeakerSpans(segments, samples.length), findSpeech(samples));
    const groups = [...new Set(spans.flatMap(span => span.group === null ? [] : [span.group]))];
    const scores = new Map<number, number>();
    if (voiceprint) {
      for (const group of groups) {
        const clips = spans.filter(span => span.group === group)
          .flatMap(span => span.parts.map(({ start, end }) => samples.subarray(start, end)));
        const embedding = embed(clips);
        if (embedding) scores.set(group, cosine(embedding, voiceprint));
      }
    }
    const labels = labelSpeakerGroups(groups, scores);
    return spans.flatMap(span => {
      const text = span.parts.map(({ start, end }) =>
        recognize(samples.subarray(Math.max(span.start, start - 4800), Math.min(span.end, end + 1600))))
        .filter(Boolean).join(' ');
      const startMs = ms(span.parts[0].start), endMs = ms(span.parts.at(-1)!.end);
      const speaker = span.group === null ? 'unknown' : labels.get(span.group)!;
      return text ? [{ startMs, endMs, speaker, text }] : [];
    });
  }

  async function analyzeMeeting(samples: Float32Array): Promise<MeetingChunk> {
    const speech = findSpeech(samples);
    if (!speech.length) return { lines: [], voices: [] };
    await prepareSpeakerModels('meeting');
    const segments = meetingDiarizer!.process(samples);
    const spans = alignSpeech(buildSpeakerSpans(segments, samples.length), speech);
    const evidence = buildSpeakerSpans(segments, samples.length, 0);
    const groups = new Map<number, Float32Array[]>();
    for (const span of alignSpeech(evidence, speech)) {
      if (span.group === null) continue;
      const clips = groups.get(span.group) ?? [];
      for (const { start, end } of span.parts) clips.push(samples.subarray(start, end));
      groups.set(span.group, clips);
    }
    const lines: MeetingCandidate[] = [];
    for (const span of spans) {
      for (const { start, end } of span.parts) {
        const inputStart = Math.max(span.start, start - 4800);
        const decoded = decode(samples.subarray(inputStart, Math.min(span.end, end + 1600)));
        const text = decoded.text.trim();
        if (!text && (!decoded.event || /speech|unknown/i.test(decoded.event))) continue;
        const recognition: MeetingRecognition = {};
        if (decoded.lang) recognition.language = decoded.lang;
        if (decoded.emotion) recognition.emotion = decoded.emotion;
        if (decoded.event) recognition.event = decoded.event;
        if (decoded.tokens?.length) recognition.tokens = decoded.tokens;
        if (decoded.timestamps?.length && decoded.timestamps.every(Number.isFinite)) {
          recognition.tokenTimesMs = decoded.timestamps.map(timestamp => ms(inputStart) + Math.round(timestamp * 1000));
        }
        const group = span.group ?? meetingSpeakerForUtterance(segments, evidence, start, end);
        lines.push({ group, startMs: ms(start), endMs: ms(end), text, recognition });
      }
    }
    const voices = [...groups].flatMap(([group, clips]) => {
      const vector = embed(clips, minimumMeetingVoiceSamples);
      return vector ? [{ group, vector, samples: clips.reduce((total, clip) => total + clip.length, 0) }] : [];
    });
    return { lines, voices };
  }

  port.on('message', async ({ data }: { data: WorkerRequest }) => {
    const started = performance.now();
    const error = (message: string) => port.postMessage({ type: 'error', id: data.id, message });
    let result: WorkerResult;
    try {
      const audioSeconds = validateSpeechWave(data.audio), samples = decodeSpeechWave(data.audio);
      if (data.type === 'embedding' || data.type === 'speakers') await prepareSpeakerModels(data.type);
      if (data.type === 'embedding') {
        const clips: Float32Array[] = [];
        voiced(samples, (_start, clip) => clips.push(clip));
        result = { type: 'embedding', embedding: embed(clips, data.meeting ? minimumMeetingVoiceSamples : minimumVoice) };
      } else {
        const language = data.type === 'speakers' ? 'auto' : data.language;
        if (config.modelConfig.senseVoice.language !== language) {
          config.modelConfig.senseVoice.language = language;
          recognizer.setConfig(config);
        }
        if (data.type === 'speakers') {
          result = { type: 'speakers', lines: analyze(samples, diarizer!.process(samples), data.voiceprint) };
        } else if (data.type === 'meeting') {
          result = { type: 'meeting', chunk: await analyzeMeeting(samples) };
        } else {
          const texts: string[] = [];
          voiced(samples, (start, clip) => texts.push(recognize(texts.length ? clip : samples.subarray(Math.max(0, start - 4800), start + clip.length))));
          result = { type: 'transcribe', result: { text: texts.filter(Boolean).join(' ').trim(), audioSeconds, inferenceSeconds: (performance.now() - started) / 1000 } };
        }
      }
      port.postMessage({ type: 'result', id: data.id, result });
    } catch (failure) {
      const message = failure instanceof Error && failure.message === '无法加载说话人模型，请修复安装后重试。' ? failure.message : '';
      error(message || (data.type === 'meeting' ? '本地会议转写失败，请重试。' :
        data.type === 'transcribe' ? '本地转写失败，请重新录音。' : '说话人处理失败，请重新录音。'));
    }
  });
  port.postMessage({ type: 'ready' });
}

void initialize().catch(() => { port.postMessage({ type: 'error', message: '无法加载内置语音引擎，请修复安装后重试。' }); });
