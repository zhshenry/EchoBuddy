import { app, clipboard, globalShortcut, ipcMain, Menu, nativeImage, net, protocol, session, shell, Tray } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { autoUpdater } from 'electron-updater';
import { isBotAvatar } from '../shared/bot-avatar';
import type { Preferences } from '../shared/desktop';
import { Dictation } from './dictation';
import { createOverlay } from './overlay';
import { loadPreferences, savePreferences, validShortcut } from './preferences';
import { SpeechEngine } from './speech/engine';
import { AppUpdates, releasesUrl } from './updater';
import { WindowsInput } from './windows-input';

const uiUrl = 'echobuddy://app/index.html';
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

  const { window, resize } = createOverlay(join(__dirname, 'preload.cjs'), join(appPath, 'assets/icon.ico'), saved.position, position => {
    saved.position = position;
    persist();
  });
  const say = (channel: string, value?: unknown) => {
    if (!window.isDestroyed()) window.webContents.send(channel, value);
  };
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
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
  const prefs = (): Preferences => ({ avatar: saved.avatar, shortcut: saved.shortcut, shortcutActive });
  const register = (value: string) => {
    try { return globalShortcut.register(value.replace('Win+', 'Super+'), toggle); }
    catch { return false; }
  };
  function toggle() {
    if (editing || updates.isInstalling()) return;
    if (!window.isVisible()) window.showInactive();
    dictation.toggle();
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
    window.setFocusable(false);
    if (window.isFocused()) window.blur();
    say('preferences:state', prefs());
    return error;
  }
  window.on('blur', () => {
    if (!editing) return;
    finishShortcut();
    say('preferences:shortcut-cancelled');
  });
  shortcutActive = register(saved.shortcut);

  function handle<Args extends unknown[]>(channel: string, action: (...args: Args) => unknown) {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame?.url !== uiUrl) throw new Error('EchoBuddy 桌面接口仅用于浮窗。');
      return action(...args as Args);
    });
  }
  handle('desktop:snapshot', () => ({ dictation: dictation.snapshot(), update: updates.snapshot(), preferences: prefs() }));
  handle('dictation:toggle', toggle);
  handle('dictation:recording', (id: string) => dictation.recording(id));
  handle('dictation:transcribe', (id: string, audio: Uint8Array) => dictation.transcribe(id, audio));
  handle('dictation:complete', (id: string, text: string, error?: string) => {
    if (typeof text === 'string' && (error === undefined || typeof error === 'string')) return dictation.complete(id, text, error);
  });
  handle('dictation:insert-pending', () => dictation.insertPending());
  handle('dictation:copy', () => dictation.copyPending());
  handle('dictation:clear-message', () => dictation.clearMessage());
  handle('overlay:resize', resize);
  handle('preferences:avatar', (avatar: string) => {
    if (!isBotAvatar(avatar)) return false;
    saved.avatar = avatar;
    persist();
    say('preferences:state', prefs());
    return true;
  });
  handle('preferences:begin-shortcut', () => {
    if (editing || updates.isInstalling() || dictation.snapshot().phase !== 'idle') return false;
    globalShortcut.unregisterAll();
    shortcutActive = false;
    editing = true;
    window.setFocusable(true);
    window.focus();
    return true;
  });
  handle('preferences:finish-shortcut', finishShortcut);
  handle('update:check', () => updates.check());
  handle('update:install', () => updates.install());
  handle('update:releases', () => shell.openExternal(releasesUrl));

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
