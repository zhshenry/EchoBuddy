import { useEffect, useRef, type CSSProperties } from 'react';
import { CaretDown, X } from '@phosphor-icons/react';
import { botAvatarChoice, botAvatarColors } from '../../shared/bot-avatar';
import { AVAILABLE_RECORDING_MODES, SHORT_DICTATION_MAX_SECONDS, type Preferences, type RecordingMode } from '../../shared/desktop';
import { RECOGNITION_LANGUAGES, type RecognitionLanguage } from '../../shared/speech-contracts';

const languageNames: Record<RecognitionLanguage, string> = {
  zh: '普通话', en: '英语', yue: '粤语', ja: '日语', ko: '韩语',
};

const modes = [
  { id: 'dictation', label: '短听写', detail: `最多 ${SHORT_DICTATION_MAX_SECONDS / 60} 分钟，到时自动转写` },
  { id: 'meeting', label: '会议录音', detail: '最长可录 2 小时，功能待接入' },
] as const;

export function RecordingOptions({ mode, busy }: { mode: RecordingMode; busy: boolean }) {
  return <fieldset className="segmented-options mode-options" disabled={busy}>
    <legend className="visually-hidden">录音模式</legend>
    {modes.map(item => <label key={item.id} title={item.detail}>
      <input className="visually-hidden" type="radio" name="recording-mode" value={item.id} checked={mode === item.id}
        disabled={!AVAILABLE_RECORDING_MODES.includes(item.id)} aria-description={item.detail}
        onChange={() => void window.echoBuddy.setRecordingMode(item.id)} />
      <span>{item.label}</span>
    </label>)}
  </fieldset>;
}

export function WriteOptions() {
  return <div className="segmented-options write-options" role="group" aria-label="听写写入时机">
    <button type="button" title="待接入" aria-description="待接入" disabled>流式输入 <small aria-hidden="true">待接入</small></button>
    <button type="button" aria-pressed="true">整句写入</button>
  </div>;
}

export function LanguageSelector({ languages, open }: { languages: RecognitionLanguage[]; open: boolean }) {
  const summary = languages.length === RECOGNITION_LANGUAGES.length
    ? '全部语言'
    : languages.map(language => languageNames[language]).join('、');
  return <button type="button" className="language-selector" aria-label={`识别语言，${summary}`} aria-haspopup="dialog"
    aria-expanded={open} title={summary} onClick={event => {
      const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
      void window.echoBuddy.toggleLanguagePanel({ left, right, top, bottom }, event.detail === 0);
    }}>
    <span>{summary}</span><CaretDown size={14} weight="bold" aria-hidden="true" />
  </button>;
}

export function LanguagePanel({ preferences, placement, tip }: { preferences: Preferences; placement: 'below' | 'above'; tip: number }) {
  const desktop = window.echoBuddy;
  const title = useRef<HTMLHeadingElement>(null);
  const { color } = botAvatarChoice(preferences.avatar);
  const palette = botAvatarColors.find(item => item.id === color)!;
  useEffect(() => {
    title.current?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      void desktop.closeLanguagePanel();
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [desktop]);
  return <main className="language-panel" role="dialog" aria-labelledby="language-panel-title" data-placement={placement}
    style={{ '--accent': palette.lo, '--tint': palette.soft, '--language-tip': `${tip}px` } as CSSProperties}>
    <header className="language-panel-header">
      <h2 id="language-panel-title" tabIndex={-1} ref={title}>识别语言</h2>
      <button type="button" className="window-button" aria-label="关闭识别语言" onClick={() => void desktop.closeLanguagePanel()}>
        <X size={17} aria-hidden="true" />
      </button>
    </header>
    <LanguageOptions languages={preferences.languages} />
    <p className="language-panel-note">自动识别</p>
  </main>;
}

function LanguageOptions({ languages }: { languages: RecognitionLanguage[] }) {
  return <fieldset className="language-options">
    <legend className="visually-hidden">选择识别语言</legend>
    {RECOGNITION_LANGUAGES.map(language => {
      const checked = languages.includes(language);
      return <label key={language}>
        <input type="checkbox" checked={checked} disabled={checked && languages.length === 1}
          onChange={() => void window.echoBuddy.toggleLanguage(language)} />
        {languageNames[language]}
      </label>;
    })}
  </fieldset>;
}
