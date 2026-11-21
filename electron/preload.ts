import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DesktopBridge } from '../shared/desktop';

function listen<T>(channel: string, callback: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const bridge: DesktopBridge = {
  snapshot: () => ipcRenderer.invoke('desktop:snapshot'),
  toggle: () => ipcRenderer.invoke('dictation:toggle'),
  recording: id => ipcRenderer.invoke('dictation:recording', id),
  transcribe: (id, audio) => ipcRenderer.invoke('dictation:transcribe', id, audio),
  writeProgress: (id, text) => ipcRenderer.invoke('dictation:write-progress', id, text),
  complete: (id, text, error) => ipcRenderer.invoke('dictation:complete', id, text, error),
  insertPending: () => ipcRenderer.invoke('dictation:insert-pending'),
  copyPending: () => ipcRenderer.invoke('dictation:copy'),
  clearMessage: () => ipcRenderer.invoke('dictation:clear-message'),
  resize: height => { void ipcRenderer.invoke('overlay:resize', height).catch(() => {}); },
  expandOverlay: () => ipcRenderer.invoke('overlay:expand'),
  finishDockMotion: id => { void ipcRenderer.invoke('overlay:dock-motion-finished', id).catch(() => {}); },
  setOverlayPanelOpen: open => ipcRenderer.invoke('overlay:panel-open', open),
  toggleLanguagePanel: (anchor, keyboard) => ipcRenderer.invoke('languages:toggle-panel', anchor, keyboard),
  closeLanguagePanel: () => ipcRenderer.invoke('languages:close-panel'),
  openSettings: page => ipcRenderer.invoke('settings:open', page),
  minimizeSettings: () => ipcRenderer.invoke('settings:minimize'),
  closeSettings: () => ipcRenderer.invoke('settings:close'),
  setRecordingMode: mode => ipcRenderer.invoke('preferences:recording-mode', mode),
  setWriteTiming: timing => ipcRenderer.invoke('preferences:write-timing', timing),
  setDockOnEdge: value => ipcRenderer.invoke('preferences:dock-on-edge', value),
  toggleLanguage: language => ipcRenderer.invoke('preferences:toggle-language', language),
  setAvatar: avatar => ipcRenderer.invoke('preferences:avatar', avatar),
  beginShortcut: () => ipcRenderer.invoke('preferences:begin-shortcut'),
  finishShortcut: shortcut => ipcRenderer.invoke('preferences:finish-shortcut', shortcut),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  releases: () => ipcRenderer.invoke('update:releases'),
  onDictation: callback => listen('dictation:state', callback),
  onPreferences: callback => listen('preferences:state', callback),
  onLanguagePanel: callback => listen('languages:panel-state', callback),
  onSettingsPage: callback => listen('settings:page', callback),
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
