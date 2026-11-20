export type DictationPhase = 'idle' | 'preparing' | 'recording' | 'finishing';
export interface DictationState {
  phase: DictationPhase;
  sessionId: string | null;
  pending: string;
  message: string;
  reveal: number;
}

export interface Preferences {
  avatar: string;
  shortcut: string;
  shortcutActive: boolean;
}

export interface UpdateStatus {
  enabled: boolean;
  current: string;
  phase: 'idle' | 'checking' | 'latest' | 'downloading' | 'ready' | 'error';
  version: string;
  progress: number;
  message: string;
}

export interface DesktopSnapshot {
  dictation: DictationState;
  preferences: Preferences;
  update: UpdateStatus;
}

export type OverlayPointer = { x: number; y: number } | null;

export interface DesktopBridge {
  snapshot(): Promise<DesktopSnapshot>;
  toggle(): Promise<void>;
  recording(id: string): Promise<void>;
  transcribe(id: string, audio: Uint8Array): Promise<string>;
  complete(id: string, text: string, error?: string): Promise<void>;
  insertPending(): Promise<void>;
  copyPending(): Promise<void>;
  clearMessage(): Promise<void>;
  resize(height: number): void;
  setAvatar(avatar: string): Promise<boolean>;
  beginShortcut(): Promise<boolean>;
  finishShortcut(shortcut?: string): Promise<string | null>;
  checkUpdate(): Promise<void>;
  installUpdate(): Promise<boolean>;
  releases(): Promise<void>;
  onDictation(handle: (state: DictationState) => void): () => void;
  onPreferences(handle: (state: Preferences) => void): () => void;
  onUpdate(handle: (state: UpdateStatus) => void): () => void;
  onOverlayPointer(handle: (point: OverlayPointer) => void): () => void;
  onShortcutCancelled(handle: () => void): () => void;
}

declare global {
  interface Window { echoBuddy: DesktopBridge }
}
