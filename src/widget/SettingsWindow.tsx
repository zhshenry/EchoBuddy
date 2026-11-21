import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowsClockwise, Keyboard, Microphone, Minus, Palette, PencilSimple, X } from '@phosphor-icons/react';
import { botAvatarChoice, botAvatarColors } from '../../shared/bot-avatar';
import { resolveSettingsPage, type DesktopSnapshot, type SettingsPage } from '../../shared/desktop';
import { BotAvatar } from '../avatars/BotAvatar';
import { AvatarPicker } from './AvatarPicker';
import { LanguageSelector, WriteOptions } from './SpeechOptions';
import { UpdateSettings } from './UpdateSettings';

const pages = [
  { id: 'voice', label: '语音', icon: Microphone },
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

export function SettingsWindow({ dictation, preferences, update }: DesktopSnapshot) {
  const desktop = window.echoBuddy;
  const [page, setPage] = useState(() => resolveSettingsPage(window.location.hash.slice(1)));
  const [languagesOpen, setLanguagesOpen] = useState(false);
  const [binding, setBinding] = useState(false);
  const [bindingError, setBindingError] = useState('');
  const title = useRef<HTMLHeadingElement>(null);
  const { color } = botAvatarChoice(preferences.avatar);
  const palette = botAvatarColors.find(item => item.id === color)!;
  const voiceTheme = { '--accent': palette.lo, '--tint': palette.soft } as CSSProperties;
  const busy = dictation.phase !== 'idle';
  const updateBlocked = busy ? '本次听写完成后可安装' : dictation.pending ? '请先写入或复制本次转写' : binding ? '请先完成快捷键设置' : '';

  useLayoutEffect(() => { title.current?.focus(); }, []);
  useEffect(() => {
    const cancel = desktop.onShortcutCancelled(() => setBinding(false));
    const languages = desktop.onLanguagePanel(setLanguagesOpen);
    const navigate = desktop.onSettingsPage(value => {
      setPage(value);
      setBinding(false);
      void desktop.finishShortcut();
    });
    return () => { cancel(); languages(); navigate(); };
  }, [desktop]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.repeat || event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (languagesOpen) void desktop.closeLanguagePanel();
        else if (binding) {
          setBinding(false);
          void desktop.finishShortcut();
        } else void desktop.closeSettings();
        return;
      }
      const shortcut = binding && combination(event);
      if (!shortcut) return;
      event.preventDefault();
      setBinding(false);
      void desktop.finishShortcut(shortcut).then(error => setBindingError(error ?? ''));
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [binding, desktop, languagesOpen]);

  async function editShortcut() {
    setBindingError('');
    if (binding) {
      setBinding(false);
      void desktop.finishShortcut();
    } else if (await desktop.beginShortcut()) setBinding(true);
  }

  function navigate(value: SettingsPage) {
    if (value === page) return;
    if (languagesOpen) void desktop.closeLanguagePanel();
    if (binding) {
      setBinding(false);
      void desktop.finishShortcut();
    }
    setPage(value);
  }

  return <main className="settings-window" aria-labelledby="settings-title" onPointerDown={event => {
    if (languagesOpen && event.target instanceof Element && !event.target.closest('.language-selector')) void desktop.closeLanguagePanel();
  }}>
    <header className="settings-header">
      <BotAvatar avatar="drop:coral" />
      <h1 id="settings-title" tabIndex={-1} ref={title}>EchoBuddy 设置</h1>
      <button type="button" className="window-button" aria-label="最小化设置" onClick={() => void desktop.minimizeSettings()}><Minus size={18} /></button>
      <button type="button" className="window-button" aria-label="关闭设置" onClick={() => void desktop.closeSettings()}><X size={18} /></button>
    </header>
    <div className="settings-layout">
      <nav className="settings-sidebar" aria-label="设置分类">
        {pages.map(({ id, label, icon: Icon }) => <button key={id} type="button"
          aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}>
          <Icon size={18} aria-hidden="true" />{label}
        </button>)}
      </nav>
      <div className="settings-content" onScroll={() => { if (languagesOpen) void desktop.closeLanguagePanel(); }}>
        {page === 'voice' && <>
          <section className="settings-section settings-inline-row" style={voiceTheme}>
            <h2>写入时机</h2>
            <WriteOptions timing={preferences.writeTiming} busy={busy} />
          </section>
          <section className="settings-section settings-inline-row" style={voiceTheme}>
            <h2>识别语言</h2>
            <LanguageSelector languages={preferences.languages} open={languagesOpen} />
          </section>
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
        {page === 'shortcuts' && <section className="settings-section">
          <div className="row">
            <h2>听写快捷键</h2>
            <button type="button" className="key-button" aria-label="修改快捷键" aria-pressed={binding} disabled={busy} onClick={() => void editShortcut()}>
              {binding ? '按下新组合键' : <span className="keys">{preferences.shortcut.split('+').map(key => <kbd key={key}>{key}</kbd>)}</span>}
              <PencilSimple size={14} />
            </button>
          </div>
          {(bindingError || (!binding && !preferences.shortcutActive)) &&
            <p className="shortcut-error" role="status">{bindingError || '快捷键已被占用，请换一组。'}</p>}
        </section>}
        {page === 'updates' && <section className="settings-section settings-updates">
          <h2>版本更新</h2>
          <UpdateSettings update={update} blocked={updateBlocked} showReleaseLink />
        </section>}
      </div>
    </div>
  </main>;
}
