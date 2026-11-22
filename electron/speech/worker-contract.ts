import type { MeetingRecognition } from '../../shared/meeting-contracts';
import type { SpeakerLine } from '../../shared/speaker-contracts';
import type { SpeechLanguage, SpeechResult } from '../../shared/speech-contracts';

export interface MeetingCandidate {
  group: number | null;
  startMs: number;
  endMs: number;
  text: string;
  recognition?: MeetingRecognition;
}

export interface MeetingChunk {
  lines: MeetingCandidate[];
  voices: { group: number; vector: number[]; samples: number }[];
}

export type SpeechOperation =
  | { type: 'transcribe'; language: SpeechLanguage }
  | { type: 'embedding'; meeting?: boolean }
  | { type: 'meeting'; language: SpeechLanguage }
  | { type: 'speakers'; voiceprint: number[] | null };

export type WorkerRequest = SpeechOperation & { id: string; audio: Uint8Array };
export type WorkerResult =
  | { type: 'transcribe'; result: SpeechResult }
  | { type: 'embedding'; embedding: number[] | null }
  | { type: 'meeting'; chunk: MeetingChunk }
  | { type: 'speakers'; lines: SpeakerLine[] };
