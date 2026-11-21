import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeImage, net, protocol, screen, session, shell, Tray } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { autoUpdater } from 'electron-updater';
import { isBotAvatar } from '../shared/bot-avatar';
import { AVAILABLE_RECORDING_MODES, resolveSettingsPage, type LanguagePanelAnchor, type Preferences, type RecordingMode, type SettingsPage } from '../shared/desktop';
import { RECOGNITION_LANGUAGES, type RecognitionLanguage } from '../shared/speech-contracts';
import { Dictation } from './dictation';
import { createOverlay } from './overlay';
import { loadPreferences, savePreferences, validShortcut } from './preferences';
import { SpeechEngine } from './speech/engine';
import { AppUpdates, releasesUrl } from './updater';
import { WindowsInput } from './windows-input';

const uiUrl = 'echobuddy://app/index.html';
const settingsUrl = uiUrl + '?view=settings';
const languageUrl = uiUrl + '?view=languages';
const meetingUnavailable = '会议录音待接入，请切换到听写。';
protocol.registerSchemesAsPrivileged([{ scheme: 'echobuddy', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }]);
app.setAppUserModelId('com.zhshenry.echobuddy');

if (!app.requestSingleInstanceLock()) app.quit();
else void app.whenReady().then(start).catch(error => {
  console.error('EchoBuddy failed to start', error);
  app.quit();
});

async function start() {
  const appPath = app.getAppPath();
  const dist = join(appPath, 'dist');
  const preload = join(__dirname, 'preload.cjs');
  const icon = join(appPath, 'assets/icon.ico');
  const preferencesPath = join(app.getPath('userData'), 'settings.json');
  const saved = loadPreferences(preferencesPath);
  function persist() {
    try { savePreferences(preferencesPath, saved); }
    catch (error) { console.error('EchoBuddy preferences could not be saved', error); }
  }

  protocol.handle('echobuddy', request => {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.hostname !== 'app') return new Response(null, { status: 404 });
    const file = resolve(dist, '.' + decodeURIComponent(url.pathname));
    const inside = relative(dist, file);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });

  const { window, resize, trackPointer } = createOverlay(preload, icon, saved.position, position => {
    saved.position = position;
    persist();
  });
  let settingsWindow: BrowserWindow | undefined;
  let languageWindow: BrowserWindow | undefined;
  const say = (channel: string, value?: unknown) => {
    for (const target of [window, settingsWindow]) {
      if (target && !target.isDestroyed()) target.webContents.send(channel, value);
    }
  };
  function restrictNavigation(target: BrowserWindow) {
    target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    target.webContents.on('will-navigate', event => event.preventDefault());
  }
  restrictNavigation(window);

  function closeLanguagePanel() { languageWindow?.close(); }
  function toggleLanguagePanel(owner: BrowserWindow, anchor: LanguagePanelAnchor, keyboard: boolean) {
    if (languageWindow) {
      const sameOwner = languageWindow.getParentWindow() === owner;
      closeLanguagePanel();
      if (sameOwner) return;
    }
    if (!owner.isVisible() || !anchor || ![anchor.left, anchor.right, anchor.top, anchor.bottom].every(Number.isFinite)) return;
    const contents = owner.webContents;
    const bounds = owner.getContentBounds();
    const { workArea } = screen.getDisplayMatching(bounds);
    const zoom = contents.getZoomFactor();
    const workRight = workArea.x + workArea.width;
    const workBottom = workArea.y + workArea.height;
    const top = Math.max(workArea.y, bounds.y + Math.floor(anchor.top * zoom));
    const bottom = Math.min(workBottom, bounds.y + Math.ceil(anchor.bottom * zoom));
    const above = top - workArea.y;
    const below = workBottom - bottom;
    const preferredHeight = Math.round(252 * zoom);
    const openBelow = below >= preferredHeight || below >= above;
    const width = Math.min(Math.round(216 * zoom), workArea.width);
    const height = Math.min(preferredHeight, openBelow ? below : above);
    if (height <= 0) return;
    // Align the card edge, allowing for its transparent horizontal padding.
    const cardRight = bounds.x + Math.round((anchor.right + 10) * zoom);
    const x = Math.max(workArea.x, Math.min(workRight - width, cardRight - width));
    const y = openBelow ? bottom : top - height;
    const tip = (bounds.x - x) / zoom + (anchor.left + anchor.right) / 2;
    const focus = owner !== window || keyboard === true && dictation.snapshot().phase === 'idle';
    const target = languageWindow = new BrowserWindow({
      parent: owner, x, y, width, height, show: false, frame: false, transparent: true,
      focusable: focus, alwaysOnTop: true, skipTaskbar: true, hasShadow: false, resizable: false,
      maximizable: false, fullscreenable: false, title: '识别语言', icon,
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, zoomFactor: zoom },
    });
    restrictNavigation(target);
    const dismiss = () => { if (!target.isDestroyed()) target.close(); };
    owner.on('move', dismiss);
    owner.on('hide', dismiss);
    owner.on('minimize', dismiss);
    owner.on('close', dismiss);
    contents.on('did-start-loading', dismiss);
    target.once('ready-to-show', () => focus ? target.show() : target.showInactive());
    target.on('closed', () => {
      if (languageWindow === target) languageWindow = undefined;
      owner.off('move', dismiss);
      owner.off('hide', dismiss);
      owner.off('minimize', dismiss);
      owner.off('close', dismiss);
      if (!contents.isDestroyed()) {
        contents.off('did-start-loading', dismiss);
        if (!owner.isDestroyed()) contents.send('languages:panel-state', false);
      }
    });
    target.webContents.on('render-process-gone', dismiss);
    contents.send('languages:panel-state', true);
    void target.loadURL(`${languageUrl}&placement=${openBelow ? 'below' : 'above'}&tip=${tip}`).catch(dismiss);
  }

  function openSettings(page: SettingsPage) {
    closeLanguagePanel();
    if (settingsWindow) {
      if (settingsWindow.isMinimized()) settingsWindow.restore();
      settingsWindow.webContents.send('settings:page', page);
      settingsWindow.show();
      return;
    }
    const { workArea } = screen.getDisplayMatching(window.getBounds());
    const width = Math.min(640, workArea.width), height = Math.min(456, workArea.height);
    const target = settingsWindow = new BrowserWindow({
      x: workArea.x + Math.round((workArea.width - width) / 2),
      y: workArea.y + Math.round((workArea.height - height) / 2),
      width, height, show: false, frame: false, transparent: true, resizable: false,
      maximizable: false, fullscreenable: false, title: 'EchoBuddy 设置', icon,
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    restrictNavigation(target);
    target.once('ready-to-show', () => target.show());
    target.on('blur', () => {
      if (quitting || !editing) return;
      finishShortcut();
      say('preferences:shortcut-cancelled');
    });
    target.on('closed', () => {
      settingsWindow = undefined;
      if (!quitting) finishShortcut();
    });
    target.webContents.on('render-process-gone', () => target.close());
    void target.loadURL(settingsUrl + '#' + page).catch(() => {
      if (!target.isDestroyed()) target.close();
    });
  }
  session.defaultSession.setPermissionRequestHandler((contents, permission, done, details) => {
    done(contents === window.webContents && contents.getURL() === uiUrl && permission === 'media' &&
      details.isMainFrame && 'mediaTypes' in details && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio');
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    contents === window.webContents && contents.getURL() === uiUrl && permission === 'media' && details.mediaType === 'audio');

  const speech = new SpeechEngine(app.isPackaged ? join(process.resourcesPath, 'speech') : join(appPath, 'vendor/speech'));
  const input = new WindowsInput(app.isPackaged ? join(process.resourcesPath, 'echo-input.exe') : join(appPath, 'dist-native/echo-input.exe'));
  const dictation = new Dictation(speech, input, value => say('dictation:state', value), text => clipboard.writeText(text));
  let editing = false;
  const updateEnabled = app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'));
  const updates = new AppUpdates(app.getVersion(), updateEnabled ? autoUpdater : null, value => say('update:state', value), () => editing || dictation.blocksInstall());

  let shortcutActive = false;
  let quitting = false;
  const prefs = (): Preferences => ({
    avatar: saved.avatar, shortcut: saved.shortcut, shortcutActive,
    recordingMode: saved.recordingMode, languages: saved.languages,
  });
  function updatePreferences() {
    persist();
    const value = prefs();
    say('preferences:state', value);
    languageWindow?.webContents.send('preferences:state', value);
  }
  const register = (value: string) => {
    try { return globalShortcut.register(value.replace('Win+', 'Super+'), toggle); }
    catch { return false; }
  };
  function toggle() {
    if (editing || updates.isInstalling()) return;
    closeLanguagePanel();
    if (!window.isVisible()) window.showInactive();
    const state = dictation.snapshot();
    if (saved.recordingMode === 'meeting' && state.phase === 'idle' && !state.pending) {
      dictation.showMessage(meetingUnavailable);
      return;
    }
    dictation.toggle(shortcutActive ? saved.shortcut : undefined);
  }
  function finishShortcut(value?: string): string | null {
    if (!editing) return null;
    editing = false;
    let error = null;
    if (value && !validShortcut(value)) error = '请选择一个组合键或 F1～F12。';
    else if (value) {
      shortcutActive = register(value);
      if (shortcutActive) { saved.shortcut = value; persist(); }
      else error = '这个快捷键已被占用，原设置已保留。';
    }
    if (!shortcutActive) shortcutActive = register(saved.shortcut);
    say('preferences:state', prefs());
    return error;
  }
  shortcutActive = register(saved.shortcut);

  type WindowScope = 'overlay' | 'settings' | 'both' | 'all';
  function authorizedWindow(event: IpcMainInvokeEvent, from: WindowScope): BrowserWindow {
    if (event.senderFrame === event.sender.mainFrame) {
      const url = event.senderFrame?.url;
      if (from !== 'settings' && event.sender === window.webContents && url === uiUrl) return window;
      if (from !== 'overlay' && settingsWindow && event.sender === settingsWindow.webContents &&
        url?.split('#')[0] === settingsUrl) return settingsWindow;
      if (from === 'all' && languageWindow && event.sender === languageWindow.webContents &&
        url?.startsWith(languageUrl + '&')) return languageWindow;
    }
    throw new Error('EchoBuddy 桌面接口仅用于应用窗口。');
  }

  function handle<Args extends unknown[]>(channel: string, action: (...args: Args) => unknown, from: WindowScope = 'overlay') {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args) => {
      authorizedWindow(event, from);
      return action(...args as Args);
    });
  }
  handle('desktop:snapshot', () => ({ dictation: dictation.snapshot(), update: updates.snapshot(), preferences: prefs() }), 'all');
  handle('dictation:toggle', toggle);
  handle('dictation:recording', (id: string) => dictation.recording(id));
  handle('dictation:transcribe', (id: string, audio: Uint8Array) => dictation.transcribe(id, audio));
  handle('dictation:complete', (id: string, text: string, error?: string) => {
    if (typeof text === 'string' && (error === undefined || typeof error === 'string')) return dictation.complete(id, text, error);
  });
  handle('dictation:insert-pending', () => dictation.insertPending());
  handle('dictation:copy', () => dictation.copyPending());
  handle('dictation:clear-message', () => dictation.showMessage(''));
  handle('overlay:resize', resize);
  handle('overlay:track-pointer', (enabled: boolean) => trackPointer(enabled === true));
  ipcMain.handle('languages:toggle-panel', (event, anchor: LanguagePanelAnchor, keyboard: boolean) =>
    toggleLanguagePanel(authorizedWindow(event, 'both'), anchor, keyboard));
  handle('languages:close-panel', closeLanguagePanel, 'all');
  handle('settings:open', (page?: SettingsPage) => openSettings(resolveSettingsPage(page)));
  handle('settings:minimize', () => settingsWindow?.minimize(), 'settings');
  handle('settings:close', () => settingsWindow?.close(), 'settings');
  handle('preferences:recording-mode', (mode: RecordingMode) => {
    if (!AVAILABLE_RECORDING_MODES.includes(mode) || dictation.snapshot().phase !== 'idle' || mode === saved.recordingMode) return;
    saved.recordingMode = mode;
    updatePreferences();
    if (mode === 'dictation' && dictation.snapshot().message === meetingUnavailable) dictation.showMessage('');
  }, 'both');
  handle('preferences:toggle-language', (language: RecognitionLanguage) => {
    if (!RECOGNITION_LANGUAGES.includes(language)) return;
    const selected = saved.languages.includes(language);
    if (selected && saved.languages.length === 1) return;
    saved.languages = RECOGNITION_LANGUAGES.filter(item => item === language ? !selected : saved.languages.includes(item));
    updatePreferences();
  }, 'all');
  handle('preferences:avatar', (avatar: string) => {
    if (!isBotAvatar(avatar)) return false;
    saved.avatar = avatar;
    updatePreferences();
    return true;
  }, 'settings');
  handle('preferences:begin-shortcut', () => {
    if (editing || updates.isInstalling() || dictation.snapshot().phase !== 'idle') return false;
    globalShortcut.unregisterAll();
    shortcutActive = false;
    editing = true;
    return true;
  }, 'settings');
  handle('preferences:finish-shortcut', finishShortcut, 'settings');
  handle('update:check', () => updates.check(), 'both');
  handle('update:install', () => updates.install(), 'both');
  handle('update:releases', () => shell.openExternal(releasesUrl), 'settings');

  const tray = new Tray(nativeImage.createFromPath(join(appPath, 'assets/tray.png')));
  tray.setToolTip('EchoBuddy · 离线听写');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示听写浮窗', click: () => { window.showInactive(); } },
    { type: 'separator' },
    { label: '退出 EchoBuddy', click: () => { app.quit(); } },
  ]));
  tray.on('double-click', () => window.showInactive());
  app.on('second-instance', () => window.showInactive());
  const timers = updateEnabled ? [
    setTimeout(() => void updates.check(), 30000),
    setInterval(() => void updates.check(), 4 * 60 * 60 * 1000),
  ] : [];
  timers.forEach(timer => timer.unref());

  window.webContents.on('render-process-gone', () => {
    if (quitting || window.isDestroyed()) return;
    const id = dictation.snapshot().sessionId;
    if (id) void dictation.complete(id, '', '浮窗已重新启动，请重试听写。');
    window.webContents.reload();
  });
  window.once('ready-to-show', () => window.showInactive());
  app.on('before-quit', () => {
    quitting = true;
    timers.forEach(clearTimeout);
    globalShortcut.unregisterAll();
    speech.close();
    input.close();
    if (!tray.isDestroyed()) tray.destroy();
  });
  app.on('window-all-closed', () => app.quit());
  await window.loadURL(uiUrl);
}
