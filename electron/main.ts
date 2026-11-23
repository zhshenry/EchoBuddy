import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeImage, net, protocol, screen, session, shell, Tray } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { autoUpdater } from 'electron-updater';
import { isBotAvatar } from '../shared/bot-avatar';
import { AVAILABLE_RECORDING_MODES, resolveSettingsPage, type LanguagePanelAnchor, type Preferences, type RecordingMode, type SettingsDestination, type SettingsPage, type WriteTiming } from '../shared/desktop';
import { MEETING_SOURCES, type MeetingLibrary, type MeetingSource, type MeetingSpeaker } from '../shared/meeting-contracts';
import type { SpeakerCapture, VoiceprintEnrollment, VoiceprintId } from '../shared/speaker-contracts';
import { RECOGNITION_LANGUAGES, type RecognitionLanguage } from '../shared/speech-contracts';
import { Dictation } from './dictation';
import { meetingAudio } from './meeting/audio-response';
import { MeetingRecording } from './meeting/recording';
import { MeetingStore, meetingId } from './meeting/store';
import { MeetingTranscription } from './meeting/transcription';
import { createOverlay } from './overlay';
import { fitOverlay } from './overlay-position';
import { loadPreferences, normalizeShortcut, savePreferences } from './preferences';
import { watchSettingsDragRefresh } from './settings-drag-refresh';
import { SpeechEngine } from './speech/engine';
import { SpeakerSession } from './speech/speaker-session';
import { AppUpdates, releasesUrl } from './updater';
import { WindowsInput } from './windows-input';

const uiUrl = 'echobuddy://app/index.html';
const settingsUrl = uiUrl + '?view=settings';
const languageUrl = uiUrl + '?view=languages';
protocol.registerSchemesAsPrivileged([{ scheme: 'echobuddy', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true, stream: true } }]);
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
  const meetingStore = new MeetingStore(join(process.env.LOCALAPPDATA || join(app.getPath('home'), 'AppData', 'Local'), 'EchoBuddy', 'Meetings'));
  function persist(): boolean {
    try { savePreferences(preferencesPath, saved); return true; }
    catch (error) { console.error('EchoBuddy preferences could not be saved', error); return false; }
  }

  protocol.handle('echobuddy', request => {
    const url = new URL(request.url);
    if (url.hostname !== 'app') return new Response(null, { status: 404 });
    if (url.pathname.startsWith('/meeting-audio/')) {
      const [id, track, extra] = url.pathname.slice('/meeting-audio/'.length).split('/');
      const source = MEETING_SOURCES.find(item => track === item + '.wav');
      const file = extra === undefined && meetingId.test(id) && source && meetingStore.audioPath(id, source);
      return file ? meetingAudio(request, file) : new Response(null, { status: 404 });
    }
    if (request.method !== 'GET') return new Response(null, { status: 404 });
    let path: string;
    try { path = decodeURIComponent(url.pathname); } catch { return new Response(null, { status: 404 }); }
    const file = resolve(dist, '.' + path);
    const inside = relative(dist, file);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });

  const overlay = createOverlay(preload, icon, saved, (position, dock) => {
    saved.position = position;
    saved.dock = dock;
    persist();
  });
  const { window } = overlay;
  let settingsWindow: BrowserWindow | undefined;
  let languageWindow: BrowserWindow | undefined;
  let settingsDestination: SettingsDestination = { page: 'voice' };
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

  function openSettings(page: SettingsPage, id?: string) {
    if (quitting) return;
    closeLanguagePanel();
    settingsDestination = { page, meetingId: id };
    if (settingsWindow) {
      if (settingsWindow.isMinimized()) settingsWindow.restore();
      settingsWindow.webContents.send('settings:page', settingsDestination);
      settingsWindow.show();
      return;
    }
    const { workArea } = screen.getDisplayMatching(window.getBounds());
    const width = 960, height = 580;
    const bounds = fitOverlay({
      x: workArea.x + (workArea.width - width) / 2,
      y: workArea.y + (workArea.height - height) / 2,
      width, height,
    }, workArea);
    const target = settingsWindow = new BrowserWindow({
      ...bounds, show: false, frame: false, transparent: true, resizable: false,
      maximizable: false, fullscreenable: false, title: 'EchoBuddy 设置', icon,
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    restrictNavigation(target);
    if (process.platform === 'win32') {
      watchSettingsDragRefresh({
        isDestroyed: () => target.isDestroyed(),
        isMinimized: () => target.isMinimized(),
        onMinimize: listener => { target.on('minimize', listener); },
        onRestore: listener => { target.on('restore', listener); },
        onShow: listener => { target.on('show', listener); },
      }, () => {
        if (!target.isDestroyed()) target.webContents.send('settings:refresh-drag');
      });
    }
    target.once('ready-to-show', () => target.show());
    target.on('blur', () => {
      if (quitting || !editing) return;
      finishShortcut();
      say('preferences:shortcut-cancelled');
    });
    target.on('closed', () => {
      settingsWindow = undefined;
      speaker.cancel();
      if (!quitting) finishShortcut();
    });
    target.webContents.on('render-process-gone', () => target.close());
    void target.loadURL(settingsUrl + '#' + page + (id ? '/' + id : '')).catch(() => {
      if (!target.isDestroyed()) target.close();
    });
  }
  const speechDirectory = app.isPackaged ? join(process.resourcesPath, 'speech') : join(appPath, 'vendor/speech');
  const speech = new SpeechEngine(speechDirectory);
  const speaker = new SpeakerSession(speech, join(app.getPath('userData'), 'voiceprint.bin'));
  let loadingMeetings: Promise<void> | undefined;
  let libraryError = '';
  function library(): MeetingLibrary {
    const voiceprintNames = Object.fromEntries(speaker.listProfiles().map(({ id, name }) => [id, name]));
    return { records: meetingStore.list(), error: libraryError, voiceprintNames };
  }
  function publishLibrary() {
    if (settingsDestination.page === 'meetings' && settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('meeting:library', library());
    }
  }
  const transcription = new MeetingTranscription(meetingStore, new SpeechEngine(speechDirectory), () => speaker.voiceprints, publishLibrary);
  function prepareMeetings(): Promise<void> {
    if (!loadingMeetings) {
      loadingMeetings = meetingStore.load().then(() => {
        libraryError = '';
        publishLibrary();
        transcription.start();
      }).catch(error => {
        loadingMeetings = undefined;
        libraryError = '无法读取本机会议记录，请检查录音文件夹。';
        publishLibrary();
        throw error;
      });
    }
    return loadingMeetings;
  }
  const meeting = new MeetingRecording(
    app.isPackaged ? join(process.resourcesPath, 'echo-meeting.exe') : join(appPath, 'dist-native/echo-meeting.exe'),
    meetingStore, prepareMeetings,
    value => {
      const short = dictation.snapshot();
      overlay.setAttention(!!(short.pending || short.message || value.message));
      say('meeting:capture', value);
    },
    () => { publishLibrary(); transcription.start(); },
  );
  function canRecord(contents: WebContents | null): boolean {
    if (!contents) return false;
    const url = contents.getURL();
    return contents === window.webContents && url === uiUrl ||
      speaker.recording && contents === settingsWindow?.webContents && url.split('#')[0] === settingsUrl;
  }
  session.defaultSession.setPermissionRequestHandler((contents, permission, done, details) => {
    done(canRecord(contents) && permission === 'media' &&
      details.isMainFrame && 'mediaTypes' in details && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio');
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    canRecord(contents) && permission === 'media' && details.mediaType === 'audio');

  const input = new WindowsInput(app.isPackaged ? join(process.resourcesPath, 'echo-input.exe') : join(appPath, 'dist-native/echo-input.exe'));
  const dictation = new Dictation(speech, input, value => {
    overlay.setAttention(!!(value.pending || value.message || meeting.snapshot().message));
    say('dictation:state', value);
  }, text => clipboard.writeText(text));
  let editing: RecordingMode | null = null;
  const updateEnabled = app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'));
  const updates = new AppUpdates(app.getVersion(), updateEnabled ? autoUpdater : null, value => say('update:state', value),
    () => editing !== null || speaker.active || meeting.active || dictation.blocksInstall());

  const shortcutActive: Preferences['shortcutActive'] = { dictation: false, meeting: false };
  let quitting = false;
  const prefs = (): Preferences => ({
    avatar: saved.avatar, shortcuts: saved.shortcuts, shortcutActive,
    recordingMode: saved.recordingMode, writeTiming: saved.writeTiming, meetingSources: saved.meetingSources,
    languages: saved.languages, dockOnEdge: saved.dockOnEdge,
  });
  function updatePreferences() {
    persist();
    const value = prefs();
    say('preferences:state', value);
    languageWindow?.webContents.send('preferences:state', value);
  }
  function registerShortcut(mode: RecordingMode, value = saved.shortcuts[mode]): boolean {
    try { return globalShortcut.register(value.replace('Win+', 'Super+'), () => toggle(mode)); }
    catch { return false; }
  }
  function registerShortcuts() {
    for (const mode of AVAILABLE_RECORDING_MODES) {
      if (!shortcutActive[mode]) shortcutActive[mode] = registerShortcut(mode);
    }
  }
  function toggle(requested?: RecordingMode) {
    if (quitting || editing || speaker.active || updates.isInstalling()) return;
    const active = meeting.active ? 'meeting' : dictation.snapshot().phase !== 'idle' ? 'dictation' : null;
    if (requested && active && requested !== active) return;
    const mode = active ?? requested ?? saved.recordingMode;
    closeLanguagePanel();
    if (!window.isVisible()) window.showInactive();
    if (mode === 'meeting') {
      if (meeting.active) meeting.stop();
      else meeting.start(saved.meetingSources, saved.languages.length === 1 ? saved.languages[0] : 'auto');
      return;
    }
    dictation.toggle(shortcutActive.dictation ? saved.shortcuts.dictation : undefined, saved.writeTiming);
  }
  function finishShortcut(value?: string): string | null {
    const mode = editing;
    if (!mode) return null;
    editing = null;
    let error = null;
    if (value !== undefined) {
      const shortcut = normalizeShortcut(value);
      if (!shortcut) error = '请选择一个组合键或 F1～F12。';
      else if (AVAILABLE_RECORDING_MODES.some(other => other !== mode && saved.shortcuts[other] === shortcut)) {
        error = '短听写和会议录音需要不同的快捷键。';
      } else if (registerShortcut(mode, shortcut)) {
        const previous = saved.shortcuts[mode];
        saved.shortcuts[mode] = shortcut;
        if (persist()) shortcutActive[mode] = true;
        else {
          saved.shortcuts[mode] = previous;
          globalShortcut.unregister(shortcut.replace('Win+', 'Super+'));
          error = '无法保存快捷键，原设置已保留。';
        }
      } else error = '这个快捷键已被占用，原设置已保留。';
    }
    registerShortcuts();
    say('preferences:state', prefs());
    return error;
  }
  registerShortcuts();

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
  handle('desktop:snapshot', () => ({
    dictation: dictation.snapshot(), meeting: meeting.snapshot(), update: updates.snapshot(), preferences: prefs(), dock: overlay.snapshot(),
  }), 'all');
  handle('dictation:toggle', () => toggle());
  handle('dictation:recording', (id: string) => dictation.recording(id));
  handle('dictation:transcribe', (id: string, audio: Uint8Array) => dictation.transcribe(id, audio));
  handle('dictation:write-progress', (id: string, text: string) => {
    if (typeof text === 'string') return dictation.writeProgress(id, text);
  });
  handle('dictation:complete', (id: string, text: string, error?: string) => {
    if (typeof text === 'string' && (error === undefined || typeof error === 'string')) return dictation.complete(id, text, error);
  });
  handle('dictation:insert-pending', () => dictation.insertPending());
  handle('dictation:copy', () => dictation.copyPending());
  handle('dictation:clear-transcript', () => dictation.clearTranscript());
  handle('dictation:clear-message', () => dictation.showMessage(''));
  handle('meeting:clear-notice', () => meeting.clearNotice());
  handle('meeting:open', (id?: string) => {
    if (id !== undefined && (typeof id !== 'string' || !meetingStore.get(id)?.durationMs)) return;
    openSettings('meetings', id);
    if (meeting.snapshot().latestId === id) meeting.clearNotice();
  });
  handle('meeting:library', async () => {
    await prepareMeetings().catch(() => {});
    return library();
  }, 'settings');
  handle('meeting:detail', (id: string) => transcription.detail(id), 'settings');
  handle('meeting:rename', async (id: string, title: string) => {
    if (typeof id !== 'string' || !meetingStore.get(id)?.durationMs) throw new Error('找不到这场会议。');
    const name = typeof title === 'string' ? title.trim() : '';
    if (!name) throw new Error('会议名称不能为空。');
    await meetingStore.update(id, { title: name });
    publishLibrary();
  }, 'settings');
  handle('meeting:rename-speaker', async (id: string, speaker: MeetingSpeaker, name: string | null) => {
    if (typeof id !== 'string') throw new Error('找不到这场会议。');
    await meetingStore.renameSpeaker(id, speaker, name);
    publishLibrary();
  }, 'settings');
  handle('meeting:delete', async (id: string) => {
    if (typeof id !== 'string' || !meetingId.test(id)) throw new Error('会议记录无效。');
    await transcription.trash(id, path => shell.trashItem(path));
    if (meeting.snapshot().latestId === id) meeting.clearNotice();
    publishLibrary();
  }, 'settings');
  handle('meeting:retry', (id: string) => transcription.retry(id), 'settings');
  handle('meeting:folder', async (id: string) => {
    if (typeof id !== 'string' || !meetingStore.get(id)?.durationMs) return '找不到这场会议的录音。';
    const error = await shell.openPath(meetingStore.directory(id));
    return error ? '无法打开录音文件夹。' : '';
  }, 'settings');
  handle('overlay:resize', overlay.resize);
  handle('overlay:track-pointer', (enabled: boolean) => overlay.trackPointer(enabled === true));
  handle('overlay:expand', overlay.expand);
  handle('overlay:compact-drag', overlay.dragCompact);
  handle('overlay:dock-motion-finished', overlay.finishDockMotion);
  handle('overlay:panel-open', (open: boolean) => overlay.setPanelOpen(open === true));
  ipcMain.handle('languages:toggle-panel', (event, anchor: LanguagePanelAnchor, keyboard: boolean) =>
    toggleLanguagePanel(authorizedWindow(event, 'both'), anchor, keyboard));
  handle('languages:close-panel', closeLanguagePanel, 'all');
  handle('settings:open', (page?: SettingsPage) => openSettings(resolveSettingsPage(page)), 'both');
  handle('settings:destination', () => settingsDestination, 'settings');
  handle('settings:minimize', () => settingsWindow?.minimize(), 'settings');
  handle('settings:close', () => settingsWindow?.close(), 'settings');
  handle('speaker:profiles', () => speaker.listProfiles(), 'settings');
  handle('speaker:rename', (id: VoiceprintId, name: unknown) => {
    const profiles = speaker.renameProfile(id, name);
    publishLibrary();
    return profiles;
  }, 'settings');
  handle('speaker:begin', (mode: SpeakerCapture, target?: VoiceprintEnrollment) =>
    editing || meeting.active || updates.isInstalling() || dictation.snapshot().phase !== 'idle' ? null : speaker.begin(mode, target), 'settings');
  handle('speaker:finish', async (id: string, audio: Uint8Array) => {
    const result = await speaker.finish(id, audio);
    if (result.type === 'enrollment' && result.saved) publishLibrary();
    return result;
  }, 'settings');
  handle('speaker:cancel', (keepSamples?: boolean) => speaker.cancel(keepSamples === true), 'settings');
  handle('speaker:delete', (id: VoiceprintId) => {
    const profiles = speaker.deleteProfile(id);
    publishLibrary();
    return profiles;
  }, 'settings');
  handle('preferences:recording-mode', (mode: RecordingMode) => {
    if (!AVAILABLE_RECORDING_MODES.includes(mode) || meeting.active || dictation.snapshot().phase !== 'idle' || mode === saved.recordingMode) return;
    saved.recordingMode = mode;
    updatePreferences();
  }, 'both');
  handle('preferences:meeting-source', (source: MeetingSource) => {
    if (meeting.active || !MEETING_SOURCES.includes(source)) return;
    const selected = saved.meetingSources.includes(source);
    if (selected && saved.meetingSources.length === 1) return;
    saved.meetingSources = MEETING_SOURCES.filter(item => item === source ? !selected : saved.meetingSources.includes(item));
    updatePreferences();
  }, 'both');
  handle('preferences:write-timing', (timing: WriteTiming) => {
    if ((timing !== 'streaming' && timing !== 'sentence') || dictation.snapshot().phase !== 'idle' || timing === saved.writeTiming) return;
    saved.writeTiming = timing;
    updatePreferences();
  }, 'both');
  handle('preferences:dock-on-edge', (enabled: boolean) => {
    if (typeof enabled !== 'boolean' || saved.dockOnEdge === enabled) return;
    saved.dockOnEdge = enabled;
    overlay.setDockOnEdge(enabled);
    updatePreferences();
  }, 'settings');
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
  handle('preferences:begin-shortcut', (mode: RecordingMode) => {
    if (!AVAILABLE_RECORDING_MODES.includes(mode) || editing || speaker.active || meeting.active || updates.isInstalling() ||
        dictation.snapshot().phase !== 'idle') return false;
    globalShortcut.unregisterAll();
    for (const item of AVAILABLE_RECORDING_MODES) shortcutActive[item] = false;
    editing = mode;
    return true;
  }, 'settings');
  handle('preferences:finish-shortcut', finishShortcut, 'settings');
  handle('update:check', () => updates.check(), 'both');
  handle('update:install', () => updates.install(), 'both');
  handle('update:releases', () => shell.openExternal(releasesUrl), 'settings');

  const tray = new Tray(nativeImage.createFromPath(join(appPath, 'assets/tray.png')));
  tray.setToolTip('EchoBuddy · 离线听写');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示听写浮窗', click: overlay.expand },
    { label: '会议记录', click: () => openSettings('meetings') },
    { type: 'separator' },
    { label: '退出 EchoBuddy', click: () => { app.quit(); } },
  ]));
  tray.on('double-click', overlay.expand);
  app.on('second-instance', overlay.expand);
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
  app.on('before-quit', event => {
    if (meeting.active) {
      event.preventDefault();
      if (!quitting) {
        quitting = true;
        transcription.close();
        void meeting.finishOnQuit().then(() => app.quit());
      }
      return;
    }
    quitting = true;
    timers.forEach(clearTimeout);
    globalShortcut.unregisterAll();
    speech.close();
    transcription.close();
    input.close();
    if (!tray.isDestroyed()) tray.destroy();
  });
  app.on('window-all-closed', () => app.quit());
  void prepareMeetings().catch(error => console.error('EchoBuddy could not load meetings', error));
  await window.loadURL(uiUrl);
}
