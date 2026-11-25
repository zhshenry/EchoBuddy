import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isBotAvatar } from '../shared/bot-avatar';
import { AVAILABLE_RECORDING_MODES, DEFAULT_SHORTCUTS, DOCK_SIDES, type DockPlacement, type Preferences } from '../shared/desktop';
import { normalizeHotword, type Hotword } from '../shared/hotwords';
import { meetingSources } from '../shared/meeting-contracts';
import { RECOGNITION_LANGUAGES } from '../shared/speech-contracts';

export type SavedPreferences = Omit<Preferences, 'shortcutActive'> & { hotwords: Hotword[]; position?: { x: number; y: number }; dock?: DockPlacement };
const shortcutModifiers = ['Ctrl', 'Alt', 'Shift', 'Win'];

export function normalizeShortcut(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const parts = value.split('+'), key = parts.pop() ?? '';
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|Space)$/.test(key)) return;
  if (!parts.length) return /^F\d+$/.test(key) ? key : undefined;
  if (new Set(parts).size !== parts.length || parts.some(part => !shortcutModifiers.includes(part))) return;
  return [...shortcutModifiers.filter(modifier => parts.includes(modifier)), key].join('+');
}

export function loadPreferences(path: string): SavedPreferences {
  const defaults: SavedPreferences = {
    avatar: 'drop:coral', shortcuts: { ...DEFAULT_SHORTCUTS }, recordingMode: 'dictation', writeTiming: 'sentence', languages: [...RECOGNITION_LANGUAGES],
    dockOnEdge: true, meetingSources: ['microphone'], hotwords: [],
  };
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    const position = saved.position;
    const dock = saved.dock;
    const dockOnEdge = typeof saved.dockOnEdge === 'boolean' ? saved.dockOnEdge : defaults.dockOnEdge;
    const languages = Array.isArray(saved.languages)
      ? RECOGNITION_LANGUAGES.filter(language => saved.languages.includes(language)) : [];
    const dictationShortcut = normalizeShortcut(saved.shortcuts?.dictation) ?? normalizeShortcut(saved.shortcut) ?? DEFAULT_SHORTCUTS.dictation;
    const meetingShortcut = normalizeShortcut(saved.shortcuts?.meeting);
    const defaultMeeting = dictationShortcut === DEFAULT_SHORTCUTS.meeting ? 'Ctrl+Alt+Shift+M' : DEFAULT_SHORTCUTS.meeting;
    return {
      avatar: isBotAvatar(saved.avatar) ? saved.avatar : defaults.avatar,
      shortcuts: {
        dictation: dictationShortcut,
        meeting: meetingShortcut && meetingShortcut !== dictationShortcut ? meetingShortcut : defaultMeeting,
      },
      recordingMode: AVAILABLE_RECORDING_MODES.includes(saved.recordingMode) ? saved.recordingMode : defaults.recordingMode,
      writeTiming: saved.writeTiming === 'streaming' ? saved.writeTiming : defaults.writeTiming,
      meetingSources: meetingSources(saved.meetingSources),
      dockOnEdge,
      languages: languages.length ? languages : defaults.languages,
      hotwords: Array.isArray(saved.hotwords) ? (saved.hotwords as unknown[]).map(normalizeHotword).filter(word => word !== null) : [],
      position: position && Number.isInteger(position.x) && Number.isInteger(position.y) ? position : undefined,
      ...(dockOnEdge && dock && DOCK_SIDES.includes(dock.side) && Number.isInteger(dock.displayId) &&
        Number.isFinite(dock.offset) && dock.offset >= 0 && dock.offset <= 1
        ? { dock: { side: dock.side, displayId: dock.displayId, offset: dock.offset } } : {}),
    };
  } catch { return defaults; }
}

export function savePreferences(path: string, preferences: SavedPreferences): void {
  const temporary = path + '.tmp';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporary, JSON.stringify(preferences, null, 2), 'utf8');
  renameSync(temporary, path);
}
