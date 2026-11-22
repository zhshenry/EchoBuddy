import { SPEECH_SAMPLE_RATE, type SpeechLanguage } from './speech-contracts';

export const MEETING_SOURCES = ['microphone', 'system'] as const;
export type MeetingSource = typeof MEETING_SOURCES[number];
export const MEETING_SOURCE_NAMES: Record<MeetingSource, string> = { microphone: '麦克风', system: '电脑声音' };
export const MEETING_MAX_SECONDS = 2 * 60 * 60;
export const MEETING_MAX_FRAMES = MEETING_MAX_SECONDS * SPEECH_SAMPLE_RATE;

export function meetingSources(value: unknown): MeetingSource[] {
  if (!Array.isArray(value)) return ['microphone'];
  const selected = MEETING_SOURCES.filter(source => value.includes(source));
  return selected.length ? selected : ['microphone'];
}

export type MeetingPhase = 'idle' | 'preparing' | 'recording' | 'saving';
export interface MeetingCaptureState {
  phase: MeetingPhase;
  startedAt: number | null;
  sources: MeetingSource[];
  latestId: string | null;
  message: string;
}
export const initialMeetingCapture: MeetingCaptureState = {
  phase: 'idle', startedAt: null, sources: [], latestId: null, message: '',
};

export type MeetingStatus = 'recording' | 'queued' | 'transcribing' | 'ready' | 'failed';
export interface MeetingRecord {
  id: string;
  title: string;
  createdAt: number;
  sources: MeetingSource[];
  language: SpeechLanguage;
  durationMs: number;
  processedMs: number;
  status: MeetingStatus;
  warning: string;
  error: string;
}

export type MeetingSpeaker = 'self' | 'unknown' | number;
export interface MeetingRecognition {
  language?: string;
  emotion?: string;
  event?: string;
  tokens?: string[];
  tokenTimesMs?: number[];
}

export interface MeetingLine {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  source: MeetingSource;
  speaker: MeetingSpeaker;
  recognition?: MeetingRecognition;
}

export interface MeetingDetail {
  record: MeetingRecord;
  lines: MeetingLine[];
}

export interface MeetingLibrary {
  records: MeetingRecord[];
  error: string;
}
