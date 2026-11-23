import type { MeetingLine, MeetingSpeaker } from '../../shared/meeting-contracts';
import { VOICEPRINT_MIN_VOICE_SECONDS } from '../../shared/speaker-contracts';
import { SPEECH_SAMPLE_RATE } from '../../shared/speech-contracts';
import { cosine, normalizeVoiceprint, voiceprintThreshold, type VoiceprintVector } from '../speech/speaker-timeline';
import type { MeetingChunk } from '../speech/worker-contract';

type MeetingVoice = MeetingChunk['voices'][number];
const minimumProfileSamples = VOICEPRINT_MIN_VOICE_SECONDS * SPEECH_SAMPLE_RATE;
const matchMargin = .08;

export class MeetingSpeakers {
  private readonly voices = new Map<number, number[]>();
  private next = 0;

  constructor(private readonly profiles: readonly VoiceprintVector[]) {}

  restore(speaker: number, vector: number[] | null): void {
    this.next = Math.max(this.next, speaker + 1);
    if (vector) this.voices.set(speaker, vector);
  }

  assign(voice: MeetingVoice, peers: readonly MeetingVoice[] = []): MeetingSpeaker {
    const { vector, samples } = voice;
    const candidates = [...this.profiles, ...Array.from(this.voices, ([id, vector]) => ({ id, vector }))]
      .map(candidate => ({ ...candidate, score: cosine(candidate.vector, vector) }))
      .sort((left, right) => right.score - left.score);
    const best = candidates[0], runnerUp = candidates[1];
    if (best && best.score >= voiceprintThreshold && best.score - (runnerUp?.score ?? -1) >= matchMargin) {
      if (typeof best.id === 'number') {
        const previous = best.vector;
        this.voices.set(best.id, normalizeVoiceprint(previous.map((value, index) => value * .8 + vector[index] * .2)) ?? previous);
        return best.id;
      }
      if (samples >= minimumProfileSamples && peers.every(other => other === voice || other.samples < minimumProfileSamples ||
        best.score - cosine(best.vector, other.vector) >= matchMargin)) return best.id;
    }
    if ((best?.score ?? -1) >= .58) return 'unknown';
    const id = this.next++;
    this.voices.set(id, vector);
    return id;
  }
}

const normalized = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function sameUtterance(left: MeetingLine, right: MeetingLine): boolean {
  const overlap = Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs);
  const shortest = Math.min(left.endMs - left.startMs, right.endMs - right.startMs);
  if (overlap < shortest * .6 || overlap <= 0) return false;
  const a = normalized(left.text), b = normalized(right.text);
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 5 && short.length >= long.length * .65 && long.includes(short);
}

const timeOrder = (a: MeetingLine, b: MeetingLine) => a.startMs - b.startMs || a.endMs - b.endMs;

export function mergeMeetingLines(lines: MeetingLine[], previous: MeetingLine[]): MeetingLine[] {
  const result: MeetingLine[] = [];
  for (const line of lines.sort(timeOrder)) {
    if (previous.some(prior => sameUtterance(prior, line))) continue;
    const match = result.findIndex(prior => prior.source !== line.source && sameUtterance(prior, line));
    if (match === -1) result.push(line);
    else {
      const prior = result[match];
      const preferred = line.source === 'system' ? line : prior;
      result[match] = { ...preferred, speaker: prior.speaker === 'self' || line.speaker === 'self' ? 'self' : preferred.speaker };
    }
  }
  return result.sort(timeOrder);
}

/** Aim for a quiet point before the fixed boundary so ordinary phrases stay in one chunk. */
export function meetingCut(lines: { startMs: number; endMs: number }[], nominalMs: number): number {
  const candidates = new Set([nominalMs]);
  for (const line of lines) {
    if (line.startMs >= nominalMs - 6000 && line.startMs <= nominalMs) candidates.add(line.startMs - 150);
  }
  for (const position of [...candidates].sort((a, b) => b - a)) {
    if (lines.every(line => line.endMs <= position - 100 || line.startMs >= position + 100)) return position;
  }
  return nominalMs;
}
