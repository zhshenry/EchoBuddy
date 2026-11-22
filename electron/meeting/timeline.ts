import type { MeetingLine, MeetingSpeaker } from '../../shared/meeting-contracts';
import { cosine, normalizeVoiceprint, voiceprintThreshold } from '../speech/speaker-timeline';

export class MeetingSpeakers {
  private readonly voices = new Map<number, number[]>();
  private next = 0;

  constructor(private readonly profile: number[] | null) {}

  restore(speaker: number, vector: number[] | null): void {
    this.next = Math.max(this.next, speaker + 1);
    if (vector) this.voices.set(speaker, vector);
  }

  assign(vector: number[], allowSelf: boolean): MeetingSpeaker {
    const similarity = this.profile ? cosine(this.profile, vector) : -1;
    const candidates = [...this.voices].map(([id, voice]) => ({ id, score: cosine(voice, vector) }))
      .sort((left, right) => right.score - left.score);
    const best = candidates[0], runnerUp = candidates[1];
    if (allowSelf && similarity >= voiceprintThreshold && similarity - (best?.score ?? -1) >= .08) return 'self';
    if (best && best.score >= voiceprintThreshold &&
        best.score - Math.max(runnerUp?.score ?? -1, similarity) >= .08) {
      const previous = this.voices.get(best.id)!;
      this.voices.set(best.id, normalizeVoiceprint(previous.map((value, index) => value * .8 + vector[index] * .2)) ?? previous);
      return best.id;
    }
    if (Math.max(similarity, best?.score ?? -1) >= .58) return 'unknown';
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
