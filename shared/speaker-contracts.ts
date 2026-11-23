export const VOICEPRINT_SAMPLES = 3;
export const VOICEPRINT_CLIP_SECONDS = 20;
export const VOICEPRINT_MIN_VOICE_SECONDS = 3;

export type VoiceprintId = 'self' | `voiceprint:${string}`;

export function isVoiceprintId(value: unknown): value is VoiceprintId {
  return value === 'self' || (typeof value === 'string' && /^voiceprint:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value));
}

export interface VoiceprintProfile {
  id: VoiceprintId;
  name: string;
}

export type VoiceprintEnrollment = { id: VoiceprintId } | { id: 'new'; name: string };

export type SpeakerCapture = 'enroll' | 'analyze';
export type SpeakerLabel = 'self' | 'a' | 'b' | 'unknown';

export interface SpeakerLine {
  speaker: SpeakerLabel;
  startMs: number;
  endMs: number;
  text: string;
}

export type SpeakerCaptureResult =
  | { type: 'enrollment'; samples: number; saved: false }
  | { type: 'enrollment'; samples: number; saved: true; profiles: VoiceprintProfile[] }
  | { type: 'transcript'; lines: SpeakerLine[] };
