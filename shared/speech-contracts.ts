export const SPEECH_SAMPLE_RATE = 16000;
export const SPEECH_MAX_SECONDS = 120;
export const SPEECH_MAX_BYTES = 4 * 1024 * 1024;
export const RECOGNITION_LANGUAGES = ['zh', 'en', 'yue', 'ja', 'ko'] as const;
export const SPEECH_LANGUAGES = ['auto', ...RECOGNITION_LANGUAGES] as const;
export type RecognitionLanguage = typeof RECOGNITION_LANGUAGES[number];
export type SpeechLanguage = typeof SPEECH_LANGUAGES[number];
export interface SpeechResult { text: string; audioSeconds: number; inferenceSeconds: number; }
