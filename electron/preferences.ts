import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isBotAvatar } from '../shared/bot-avatar';

export const defaultShortcut = 'Ctrl+Alt+M';
export type SavedPreferences = { avatar: string; shortcut: string; position?: { x: number; y: number } };

export function validShortcut(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = value.split('+'), key = parts.pop() ?? '';
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|Space)$/.test(key)) return false;
  if (!parts.length) return /^F\d+$/.test(key);
  return new Set(parts).size === parts.length && parts.every(part => ['Ctrl', 'Alt', 'Shift', 'Win'].includes(part));
}

export function loadPreferences(path: string): SavedPreferences {
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    const position = saved.position;
    return {
      avatar: isBotAvatar(saved.avatar) ? saved.avatar : 'drop:coral',
      shortcut: validShortcut(saved.shortcut) ? saved.shortcut : defaultShortcut,
      position: position && Number.isInteger(position.x) && Number.isInteger(position.y) ? position : undefined,
    };
  } catch { return { avatar: 'drop:coral', shortcut: defaultShortcut }; }
}

export function savePreferences(path: string, preferences: SavedPreferences): void {
  const temporary = path + '.tmp';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporary, JSON.stringify(preferences, null, 2), 'utf8');
  renameSync(temporary, path);
}
