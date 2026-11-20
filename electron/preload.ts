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
  complete: (id, text, error) => ipcRenderer.invoke('dictation:complete', id, text, error),
  insertPending: () => ipcRenderer.invoke('dictation:insert-pending'),
  copyPending: () => ipcRenderer.invoke('dictation:copy'),
  clearMessage: () => ipcRenderer.invoke('dictation:clear-message'),
  resize: height => { void ipcRenderer.invoke('overlay:resize', height).catch(() => {}); },
  setAvatar: avatar => ipcRenderer.invoke('preferences:avatar', avatar),
  beginShortcut: () => ipcRenderer.invoke('preferences:begin-shortcut'),
  finishShortcut: shortcut => ipcRenderer.invoke('preferences:finish-shortcut', shortcut),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  releases: () => ipcRenderer.invoke('update:releases'),
  onDictation: callback => listen('dictation:state', callback),
  onPreferences: callback => listen('preferences:state', callback),
  onUpdate: callback => listen('update:state', callback),
  onShortcutCancelled: callback => listen('preferences:shortcut-cancelled', callback),
};
contextBridge.exposeInMainWorld('echoBuddy', bridge);
