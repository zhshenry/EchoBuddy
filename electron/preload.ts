import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DesktopBridge } from '../shared/desktop';

function listen<T>(channel: string, callback: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const bridge: DesktopBridge = {
  feedback: {
    prepare: (description, page) => ipcRenderer.invoke('feedback:prepare', description, page),
    list: () => ipcRenderer.invoke('feedback:list'), send: (id, channel) => ipcRenderer.invoke('feedback:send', id, channel),
    delivery: force => ipcRenderer.invoke('feedback:delivery', force), setMode: mode => ipcRenderer.invoke('feedback:setMode', mode),
    copyWelink: id => ipcRenderer.invoke('feedback:copyWelink', id),
    refresh: id => ipcRenderer.invoke('feedback:refresh', id), export: id => ipcRenderer.invoke('feedback:export', id),
    copy: id => ipcRenderer.invoke('feedback:copy', id),
  },
  snapshot: () => ipcRenderer.invoke('desktop:snapshot'),
  toggle: () => ipcRenderer.invoke('dictation:toggle'),
  recording: id => ipcRenderer.invoke('dictation:recording', id),
  transcribe: (id, audio) => ipcRenderer.invoke('dictation:transcribe', id, audio),
  writeProgress: (id, text) => ipcRenderer.invoke('dictation:write-progress', id, text),
  complete: (id, text, error) => ipcRenderer.invoke('dictation:complete', id, text, error),
  insertPending: () => ipcRenderer.invoke('dictation:insert-pending'),
  copyPending: () => ipcRenderer.invoke('dictation:copy'),
  clearTranscript: () => ipcRenderer.invoke('dictation:clear-transcript'),
  clearMessage: () => ipcRenderer.invoke('dictation:clear-message'),
  clearMeetingNotice: () => ipcRenderer.invoke('meeting:clear-notice'),
  openMeeting: id => ipcRenderer.invoke('meeting:open', id),
  meetingLibrary: () => ipcRenderer.invoke('meeting:library'),
  meetingDetail: id => ipcRenderer.invoke('meeting:detail', id),
  renameMeeting: (id, title) => ipcRenderer.invoke('meeting:rename', id, title),
  renameMeetingSpeaker: (id, speaker, name) => ipcRenderer.invoke('meeting:rename-speaker', id, speaker, name),
  deleteMeeting: id => ipcRenderer.invoke('meeting:delete', id),
  retryMeeting: id => ipcRenderer.invoke('meeting:retry', id),
  openMeetingFolder: id => ipcRenderer.invoke('meeting:folder', id),
  resize: height => ipcRenderer.invoke('overlay:resize', height).catch(() => undefined),
  expandOverlay: () => ipcRenderer.invoke('overlay:expand'),
  dragCompact: point => { void ipcRenderer.invoke('overlay:compact-drag', point).catch(() => {}); },
  finishDockMotion: id => { void ipcRenderer.invoke('overlay:dock-motion-finished', id).catch(() => {}); },
  setOverlayPanelOpen: open => ipcRenderer.invoke('overlay:panel-open', open),
  toggleLanguagePanel: (anchor, keyboard) => ipcRenderer.invoke('languages:toggle-panel', anchor, keyboard),
  closeLanguagePanel: () => ipcRenderer.invoke('languages:close-panel'),
  openSettings: page => ipcRenderer.invoke('settings:open', page),
  settingsDestination: () => ipcRenderer.invoke('settings:destination'),
  minimizeSettings: () => ipcRenderer.invoke('settings:minimize'),
  closeSettings: () => ipcRenderer.invoke('settings:close'),
  hotwords: () => ipcRenderer.invoke('hotwords:list'),
  saveHotword: (word, previous) => ipcRenderer.invoke('hotwords:save', word, previous),
  deleteHotword: text => ipcRenderer.invoke('hotwords:delete', text),
  voiceprints: () => ipcRenderer.invoke('speaker:profiles'),
  renameVoiceprint: (id, name) => ipcRenderer.invoke('speaker:rename', id, name),
  beginSpeakerCapture: (mode, target) => ipcRenderer.invoke('speaker:begin', mode, target),
  finishSpeakerCapture: (id, audio) => ipcRenderer.invoke('speaker:finish', id, audio),
  cancelSpeakerCapture: keepSamples => ipcRenderer.invoke('speaker:cancel', keepSamples),
  deleteVoiceprint: id => ipcRenderer.invoke('speaker:delete', id),
  setRecordingMode: mode => ipcRenderer.invoke('preferences:recording-mode', mode),
  toggleMeetingSource: source => ipcRenderer.invoke('preferences:meeting-source', source),
  setWriteTiming: timing => ipcRenderer.invoke('preferences:write-timing', timing),
  setDockOnEdge: value => ipcRenderer.invoke('preferences:dock-on-edge', value),
  toggleLanguage: language => ipcRenderer.invoke('preferences:toggle-language', language),
  setAvatar: avatar => ipcRenderer.invoke('preferences:avatar', avatar),
  beginShortcut: mode => ipcRenderer.invoke('preferences:begin-shortcut', mode),
  finishShortcut: shortcut => ipcRenderer.invoke('preferences:finish-shortcut', shortcut),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  releases: () => ipcRenderer.invoke('update:releases'),
  onDictation: callback => listen('dictation:state', callback),
  onMeetingCapture: callback => listen('meeting:capture', callback),
  onMeetingLibrary: callback => listen('meeting:library', callback),
  onPreferences: callback => listen('preferences:state', callback),
  onLanguagePanel: callback => listen('languages:panel-state', callback),
  onSettingsPage: callback => listen('settings:page', callback),
  onSettingsDragRefresh: callback => listen('settings:refresh-drag', callback),
  onUpdate: callback => listen('update:state', callback),
  onOverlayDock: callback => listen('overlay:dock', callback),
  onOverlayPointer: callback => {
    const unsubscribe = listen('overlay:pointer', callback);
    void ipcRenderer.invoke('overlay:track-pointer', true).catch(() => {});
    return () => {
      unsubscribe();
      if (!ipcRenderer.listenerCount('overlay:pointer')) void ipcRenderer.invoke('overlay:track-pointer', false).catch(() => {});
    };
  },
  onShortcutCancelled: callback => listen('preferences:shortcut-cancelled', callback),
};
contextBridge.exposeInMainWorld('echoBuddy', bridge);
