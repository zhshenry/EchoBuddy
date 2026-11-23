import type { RecognitionLanguage } from './speech-contracts';
import type { SpeakerCapture, SpeakerCaptureResult } from './speaker-contracts';

export const SHORT_DICTATION_MAX_SECONDS = 120;

export type DictationPhase = 'idle' | 'preparing' | 'recording' | 'finishing';
export interface DictationState {
  phase: DictationPhase;
  sessionId: string | null;
  recordingStartedAt: number | null;
  pending: string;
  message: string;
  reveal: number;
}

export type RecordingMode = 'dictation' | 'meeting';
export const AVAILABLE_RECORDING_MODES: readonly RecordingMode[] = ['dictation', 'meeting'];
export type WriteTiming = 'streaming' | 'sentence';
export const DOCK_SIDES = ['left', 'right', 'top'] as const;
export type DockSide = typeof DOCK_SIDES[number];
export type DockPlacement = { side: DockSide; displayId: number; offset: number };
type DockBounds = { x: number; y: number; width: number; height: number };
export type OverlayDock = {
  side: DockSide;
  compact: boolean;
  layout: { compact: DockBounds; expanded: DockBounds };
  motion?: number;
} | null;
export type SettingsPage = 'voice' | 'appearance' | 'shortcuts' | 'updates' | 'meetings';

export interface SettingsDestination {
  page: SettingsPage;
  meetingId?: string;
}

export function resolveSettingsPage(value: unknown): SettingsPage {
  return value === 'appearance' || value === 'shortcuts' || value === 'updates' || value === 'meetings' ? value : 'voice';
}

export interface Preferences {
  avatar: string;
  shortcut: string;
  shortcutActive: boolean;
  recordingMode: RecordingMode;
  writeTiming: WriteTiming;
  meetingSources: MeetingSource[];
  dockOnEdge: boolean;
  languages: RecognitionLanguage[];
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
  meeting: MeetingCaptureState;
  preferences: Preferences;
  update: UpdateStatus;
  dock: OverlayDock;
}

export type OverlayPointer = { x: number; y: number } | null;
export type LanguagePanelAnchor = { left: number; right: number; top: number; bottom: number };

export interface DesktopBridge {
  snapshot(): Promise<DesktopSnapshot>;
  toggle(): Promise<void>;
  recording(id: string): Promise<void>;
  transcribe(id: string, audio: Uint8Array): Promise<string>;
  writeProgress(id: string, text: string): Promise<void>;
  complete(id: string, text: string, error?: string): Promise<void>;
  insertPending(): Promise<void>;
  copyPending(): Promise<void>;
  clearMessage(): Promise<void>;
  clearMeetingNotice(): Promise<void>;
  openMeeting(id?: string): Promise<void>;
  meetingLibrary(): Promise<MeetingLibrary>;
  meetingDetail(id: string): Promise<MeetingDetail | null>;
  retryMeeting(id: string): Promise<void>;
  openMeetingFolder(id: string): Promise<string>;
  resize(height: number): void;
  expandOverlay(): Promise<void>;
  finishDockMotion(id: number): void;
  setOverlayPanelOpen(open: boolean): Promise<void>;
  toggleLanguagePanel(anchor: LanguagePanelAnchor, keyboard: boolean): Promise<void>;
  closeLanguagePanel(): Promise<void>;
  openSettings(page?: SettingsPage): Promise<void>;
  settingsDestination(): Promise<SettingsDestination>;
  minimizeSettings(): Promise<void>;
  closeSettings(): Promise<void>;
  hasVoiceprint(): Promise<boolean>;
  beginSpeakerCapture(mode: SpeakerCapture): Promise<string | null>;
  finishSpeakerCapture(id: string, audio: Uint8Array): Promise<SpeakerCaptureResult>;
  cancelSpeakerCapture(keepSamples?: boolean): Promise<void>;
  deleteVoiceprint(): Promise<void>;
  setRecordingMode(mode: RecordingMode): Promise<void>;
  toggleMeetingSource(source: MeetingSource): Promise<void>;
  setWriteTiming(timing: WriteTiming): Promise<void>;
  setDockOnEdge(value: boolean): Promise<void>;
  toggleLanguage(language: RecognitionLanguage): Promise<void>;
  setAvatar(avatar: string): Promise<boolean>;
  beginShortcut(): Promise<boolean>;
  finishShortcut(shortcut?: string): Promise<string | null>;
  checkUpdate(): Promise<void>;
  installUpdate(): Promise<boolean>;
  releases(): Promise<void>;
  onDictation(handle: (state: DictationState) => void): () => void;
  onMeetingCapture(handle: (state: MeetingCaptureState) => void): () => void;
  onMeetingLibrary(handle: (value: MeetingLibrary) => void): () => void;
  onPreferences(handle: (state: Preferences) => void): () => void;
  onLanguagePanel(handle: (open: boolean) => void): () => void;
  onSettingsPage(handle: (destination: SettingsDestination) => void): () => void;
  onSettingsDragRefresh(handle: () => void): () => void;
  onUpdate(handle: (state: UpdateStatus) => void): () => void;
  onOverlayDock(handle: (state: OverlayDock) => void): () => void;
  onOverlayPointer(handle: (point: OverlayPointer) => void): () => void;
  onShortcutCancelled(handle: () => void): () => void;
}

declare global {
  interface Window { echoBuddy: DesktopBridge }
}
import type { MeetingCaptureState, MeetingDetail, MeetingLibrary, MeetingSource } from './meeting-contracts';
