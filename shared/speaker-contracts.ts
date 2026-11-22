export const VOICEPRINT_SAMPLES = 3;
export const VOICEPRINT_CLIP_SECONDS = 20;
export const VOICEPRINT_MIN_VOICE_SECONDS = 3;

export type SpeakerCapture = 'enroll' | 'analyze';
export type SpeakerLabel = 'self' | 'a' | 'b' | 'unknown';

export interface SpeakerLine {
  speaker: SpeakerLabel;
  startMs: number;
  endMs: number;
  text: string;
}

export type SpeakerCaptureResult =
  | { type: 'enrollment'; samples: number; saved: boolean }
  | { type: 'transcript'; lines: SpeakerLine[] };
