import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowsClockwise, Keyboard, Microphone, Minus, Palette, PencilSimple, Waveform, X } from '@phosphor-icons/react';
import { botAvatarChoice, botAvatarColors } from '../../shared/bot-avatar';
import { AVAILABLE_RECORDING_MODES, RECORDING_MODE_NAMES, resolveSettingsPage, type DesktopSnapshot, type RecordingMode, type SettingsDestination } from '../../shared/desktop';
import { BotAvatar } from '../avatars/BotAvatar';
import { AvatarPicker } from './AvatarPicker';
import { MeetingRecords } from './MeetingRecords';
import { LanguageSelector, WriteOptions } from './SpeechOptions';
import { refreshSettingsDragRegion } from './settings-drag-region';
import { SpeakerSettings } from './SpeakerSettings';
import { UpdateSettings } from './UpdateSettings';

const pages = [
  { id: 'voice', label: '语音', icon: Microphone },
  { id: 'meetings', label: '会议记录', icon: Waveform },
  { id: 'appearance', label: '个性化', icon: Palette },
  { id: 'shortcuts', label: '快捷键', icon: Keyboard },
  { id: 'updates', label: '版本更新', icon: ArrowsClockwise },
] as const;

function combination(event: KeyboardEvent): string {
  const key = event.code.replace(/^(Key|Digit)/, '');
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|Space)$/.test(key)) return '';
  if (!(event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || /^F\d/.test(key))) return '';
  return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Win', key].filter(Boolean).join('+');
}

export function SettingsWindow({ dictation, meeting, preferences, update }: DesktopSnapshot) {
  const desktop = window.echoBuddy;
  const [{ page, meetingId }, setDestination] = useState<SettingsDestination>(() => {
    const [initialPage, id] = window.location.hash.slice(1).split('/', 2);
    return { page: resolveSettingsPage(initialPage), meetingId: id };
  });
  const [languagesOpen, setLanguagesOpen] = useState(false);
  const [binding, setBinding] = useState<RecordingMode | null>(null);
  const [bindingError, setBindingError] = useState<{ mode: RecordingMode; message: string } | null>(null);
  const header = useRef<HTMLElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const { color } = botAvatarChoice(preferences.avatar);
  const palette = botAvatarColors.find(item => item.id === color)!;
  const voiceTheme = { '--accent': palette.lo, '--tint': palette.soft } as CSSProperties;
  const meetingBusy = meeting.phase !== 'idle';
  const busy = meetingBusy || dictation.phase !== 'idle';
  const updateBlocked = meetingBusy ? '会议录音保存后可安装' : busy ? '本次听写完成后可安装'
    : dictation.pending ? '请先写入或复制本次转写' : binding ? '请先完成快捷键设置' : '';

  useLayoutEffect(() => { title.current?.focus(); }, []);
  useEffect(() => {
    let active = true, navigated = false;
    const apply = (target: SettingsDestination) => {
      setDestination(previous => ({ page: target.page, meetingId: target.meetingId ?? previous.meetingId }));
    };
    const cancel = desktop.onShortcutCancelled(() => setBinding(null));
    const languages = desktop.onLanguagePanel(setLanguagesOpen);
    const navigate = desktop.onSettingsPage(target => {
      navigated = true;
      apply(target);
      setBinding(null);
      void desktop.finishShortcut();
    });
    void desktop.settingsDestination().then(target => { if (active && !navigated) apply(target); }).catch(() => {});
    return () => { active = false; cancel(); languages(); navigate(); };
  }, [desktop]);
  useEffect(() => desktop.onSettingsDragRefresh(() => {
    if (header.current) refreshSettingsDragRegion(header.current, run => { requestAnimationFrame(run); });
  }), [desktop]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.repeat || event.isComposing) return;
      if (event.key === 'Escape') {
        if (document.querySelector('dialog:modal')) return;
        event.preventDefault();
        if (languagesOpen) void desktop.closeLanguagePanel();
        else if (binding) {
          setBinding(null);
          void desktop.finishShortcut();
        } else void desktop.closeSettings();
        return;
      }
      if (!binding) return;
      const shortcut = combination(event);
      if (!shortcut) return;
      event.preventDefault();
      setBinding(null);
      void desktop.finishShortcut(shortcut).then(message => setBindingError(message ? { mode: binding, message } : null));
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [binding, desktop, languagesOpen]);

  async function editShortcut(mode: RecordingMode) {
    setBindingError(null);
    if (binding) {
      setBinding(null);
      void desktop.finishShortcut();
    } else if (await desktop.beginShortcut(mode)) setBinding(mode);
  }

  return <main className="settings-window" aria-labelledby="settings-title" onPointerDown={event => {
    if (languagesOpen && event.target instanceof Element && !event.target.closest('.language-selector')) void desktop.closeLanguagePanel();
  }}>
    <header className="settings-header" ref={header}>
      <BotAvatar avatar="drop:coral" />
      <h1 id="settings-title" tabIndex={-1} ref={title}>EchoBuddy 设置</h1>
      <button type="button" className="window-button" aria-label="最小化设置" onClick={() => void desktop.minimizeSettings()}><Minus size={18} /></button>
      <button type="button" className="window-button" aria-label="关闭设置" onClick={() => void desktop.closeSettings()}><X size={18} /></button>
    </header>
    <div className="settings-layout">
      <nav className="settings-sidebar" aria-label="设置分类">
        {pages.map(({ id, label, icon: Icon }) => <button key={id} type="button"
          aria-current={page === id ? 'page' : undefined} onClick={() => { if (id !== page) void desktop.openSettings(id); }}>
          <Icon size={18} aria-hidden="true" />{label}
        </button>)}
      </nav>
      {page === 'meetings' &&
        <MeetingRecords selected={meetingId} onSelect={id => setDestination(previous => ({ ...previous, meetingId: id }))} />}
      {page !== 'meetings' && <div className="settings-content" onScroll={() => { if (languagesOpen) void desktop.closeLanguagePanel(); }}>
        {page === 'voice' && <>
          <section className="settings-section settings-inline-row" style={voiceTheme}>
            <h2>写入时机</h2>
            <WriteOptions timing={preferences.writeTiming} busy={busy} />
          </section>
          <section className="settings-section settings-inline-row" style={voiceTheme}>
            <h2>识别语言</h2>
            <LanguageSelector languages={preferences.languages} open={languagesOpen} />
          </section>
          <SpeakerSettings busy={busy} />
          <section className="settings-section">
            <h2>自定义热词</h2>
            <div className="hotword-controls">
              <input type="text" aria-label="输入词语" placeholder="输入词语" disabled />
              <button type="button" disabled>添加</button>
            </div>
            <p className="settings-note">热词识别待接入。</p>
          </section>
        </>}
        {page === 'appearance' && <>
          <AvatarPicker avatar={preferences.avatar} />
          <section className="settings-section dock-preference">
            <div className="row">
              <h2 id="dock-preference-title">贴边自动收起</h2>
              <div className="switch" role="group" aria-labelledby="dock-preference-title">
                <button type="button" aria-pressed={preferences.dockOnEdge}
                  onClick={() => void desktop.setDockOnEdge(true)}>是</button>
                <button type="button" aria-pressed={!preferences.dockOnEdge}
                  onClick={() => void desktop.setDockOnEdge(false)}>否</button>
              </div>
            </div>
          </section>
        </>}
        {page === 'shortcuts' && AVAILABLE_RECORDING_MODES.map(mode => {
          const label = RECORDING_MODE_NAMES[mode] + '快捷键';
          const isBinding = binding === mode;
          const error = bindingError?.mode === mode ? bindingError.message
            : !binding && !preferences.shortcutActive[mode] ? '快捷键已被占用，请换一组。' : '';
          return <section className="settings-section" key={mode}>
            <div className="row settings-inline-row">
              <h2>{label}</h2>
              <button type="button" className="key-button" aria-label={'修改' + label} aria-pressed={isBinding}
                disabled={busy || (binding !== null && !isBinding)} onClick={() => void editShortcut(mode)}>
                {isBinding ? '按下新组合键' : <span className="keys">{preferences.shortcuts[mode].split('+').map(key => <kbd key={key}>{key}</kbd>)}</span>}
                <PencilSimple size={14} aria-hidden="true" />
              </button>
            </div>
            {error && <p className="shortcut-error" role="status">{error}</p>}
          </section>;
        })}
        {page === 'updates' && <section className="settings-section settings-updates">
          <h2>版本更新</h2>
          <UpdateSettings update={update} blocked={updateBlocked} showReleaseLink />
        </section>}
      </div>}
    </div>
  </main>;
}
