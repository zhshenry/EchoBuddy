import type { RecognitionLanguage } from './speech-contracts';

export type Hotword = { text: string; aliases: string[] };
export type HotwordChange = { hotwords: Hotword[] } | { error: string };

export function supportsHotwords(languages: readonly RecognitionLanguage[]): boolean {
  return languages.length > 0 && languages.every(language => language === 'zh' || language === 'en');
}

function spelling(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFC').replace(/\s+/gu, ' ').trim() : '';
}

export function hotwordKey(text: string): string {
  return text.toLowerCase();
}

export function normalizeHotword(value: unknown): Hotword | null {
  if (!value || typeof value !== 'object' || !('text' in value)) return null;
  const text = spelling(value.text);
  if (!/[\p{L}\p{N}]/u.test(text)) return null;
  const seen = new Set([hotwordKey(text)]);
  const aliases = 'aliases' in value && Array.isArray(value.aliases) ? value.aliases.map(spelling).filter(alias => {
    const key = hotwordKey(alias);
    if (!/[\p{L}\p{N}]/u.test(alias) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }) : [];
  return { text, aliases };
}
