import type { SpeakerLabel, VoiceprintId } from '../../shared/speaker-contracts';
import { SPEECH_SAMPLE_RATE as rate } from '../../shared/speech-contracts';

export interface DiarizedSegment { start: number; end: number; speaker: number; }
export interface SpeakerSpan { start: number; end: number; group: number | null; }
export interface VoiceprintVector { id: VoiceprintId; vector: number[]; }

export const minimumMeetingVoiceSamples = Math.round(1.2 * rate);
export const voiceprintDimension = 192;
export const voiceprintRevision = 'campp-zh-cn-common-v1';
export const voiceprintThreshold = .65;

export function normalizeVoiceprint(embedding: ArrayLike<number>): number[] | null {
  if (embedding.length !== voiceprintDimension) return null;
  const norm = Math.hypot(...Array.from(embedding));
  return norm > 0 && Number.isFinite(norm) ? Array.from(embedding, value => value / norm) : null;
}

export function cosine(left: number[], right: number[]): number {
  return left.reduce((sum, value, i) => sum + value * right[i], 0);
}

export function buildSpeakerSpans(segments: DiarizedSegment[], length: number, minimumSamples = minimumMeetingVoiceSamples): SpeakerSpan[] {
  const inSamples = (seconds: number) => Math.min(length, Math.max(0, Math.round(seconds * rate)));
  const spans = segments.map(({ start, end, speaker }) => ({ start: inSamples(start), end: inSamples(end), speaker }))
    .filter(span => span.start < span.end);
  const boundaries = [...new Set([0, length, ...spans.flatMap(({ start, end }) => [start, end])])].sort((a, b) => a - b);
  const timeline: SpeakerSpan[] = [];
  for (let i = 1; i < boundaries.length; i++) {
    const start = boundaries[i - 1], end = boundaries[i];
    const active = new Set(spans.filter(span => span.start < end && span.end > start).map(span => span.speaker));
    const group = active.size === 1 ? active.values().next().value! : null;
    const previous = timeline.at(-1);
    if (previous && previous.group === group) previous.end = end;
    else timeline.push({ start, end, group });
  }

  const result: SpeakerSpan[] = [];
  for (const span of timeline) {
    const group = span.end - span.start >= minimumSamples ? span.group : null;
    const previous = result.at(-1);
    if (previous && previous.group === group) previous.end = span.end;
    else result.push({ ...span, group });
  }
  return result;
}

/** Attribute a whole utterance when its short single-speaker spans agree. */
export function meetingSpeakerForUtterance(
  segments: DiarizedSegment[], spans: SpeakerSpan[], start: number, end: number,
): number | null {
  // Raw detections also include speakers whose spans are completely overlapped.
  const active = new Set(segments.filter(segment => Math.round(segment.start * rate) < end &&
    Math.round(segment.end * rate) > start).map(segment => segment.speaker));
  if (active.size !== 1) return null;
  const group = active.values().next().value!;
  const covered = spans.reduce((total, span) => span.group === group
    ? total + Math.max(0, Math.min(end, span.end) - Math.max(start, span.start)) : total, 0);
  return covered * 2 >= end - start ? group : null;
}

export function labelSpeakerGroups(groups: number[], scores: ReadonlyMap<number, number>): Map<number, SpeakerLabel> {
  const ranked = [...scores].sort((a, b) => b[1] - a[1]);
  const best = ranked[0];
  // If both voices sound close to the profile, leave both anonymous.
  const self = best && best[1] >= voiceprintThreshold && best[1] - (ranked[1]?.[1] ?? -1) >= .10 ? best[0] : null;
  const anonymousLabels: SpeakerLabel[] = self === null ? ['a', 'b'] : ['b'];
  return new Map(groups.map(group => [group, self === group ? 'self' : anonymousLabels.shift() ?? 'unknown']));
}
