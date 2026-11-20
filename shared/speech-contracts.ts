export const SPEECH_SAMPLE_RATE = 16000;
export const SPEECH_MAX_SECONDS = 120;
export const SPEECH_MAX_BYTES = 4 * 1024 * 1024;
export const SPEECH_LANGUAGES = ['auto', 'zh', 'en', 'yue', 'ja', 'ko'] as const;
export type SpeechLanguage = typeof SPEECH_LANGUAGES[number];
export interface SpeechResult { text: string; audioSeconds: number; inferenceSeconds: number; }
