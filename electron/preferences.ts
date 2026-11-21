import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isBotAvatar } from '../shared/bot-avatar';
import { AVAILABLE_RECORDING_MODES, type Preferences } from '../shared/desktop';
import { RECOGNITION_LANGUAGES } from '../shared/speech-contracts';

export const defaultShortcut = 'Ctrl+Alt+M';
export type SavedPreferences = Omit<Preferences, 'shortcutActive'> & { position?: { x: number; y: number } };

export function validShortcut(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = value.split('+'), key = parts.pop() ?? '';
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|Space)$/.test(key)) return false;
  if (!parts.length) return /^F\d+$/.test(key);
  return new Set(parts).size === parts.length && parts.every(part => ['Ctrl', 'Alt', 'Shift', 'Win'].includes(part));
}

export function loadPreferences(path: string): SavedPreferences {
  const defaults: SavedPreferences = {
    avatar: 'drop:coral', shortcut: defaultShortcut, recordingMode: 'dictation', languages: [...RECOGNITION_LANGUAGES],
  };
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    const position = saved.position;
    const languages = Array.isArray(saved.languages)
      ? RECOGNITION_LANGUAGES.filter(language => saved.languages.includes(language)) : [];
    return {
      avatar: isBotAvatar(saved.avatar) ? saved.avatar : defaults.avatar,
      shortcut: validShortcut(saved.shortcut) ? saved.shortcut : defaultShortcut,
      recordingMode: AVAILABLE_RECORDING_MODES.includes(saved.recordingMode) ? saved.recordingMode : defaults.recordingMode,
      languages: languages.length ? languages : defaults.languages,
      position: position && Number.isInteger(position.x) && Number.isInteger(position.y) ? position : undefined,
    };
  } catch { return defaults; }
}

export function savePreferences(path: string, preferences: SavedPreferences): void {
  const temporary = path + '.tmp';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporary, JSON.stringify(preferences, null, 2), 'utf8');
  renameSync(temporary, path);
}
