import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUpRight, ChatCircleDots, GearSix, Microphone, Stop, X } from '@phosphor-icons/react';
import { botAvatarChoice, botAvatarColors } from '../shared/bot-avatar';
import type { DesktopSnapshot } from '../shared/desktop';
import { RECOGNITION_LANGUAGES } from '../shared/speech-contracts';
import { BotAvatar } from './avatars/BotAvatar';
import { useCapture } from './audio/useCapture';
import { SettingsWindow } from './widget/SettingsWindow';
import { LanguagePanel, LanguageSelector, RecordingOptions, WriteOptions } from './widget/SpeechOptions';
import { UpdateNotice, UpdateSettings } from './widget/UpdateSettings';
import './avatars/avatar.css';
import './widget/widget.css';

const desktop = window.echoBuddy;
const initial: DesktopSnapshot = {
  dictation: { phase: 'idle', sessionId: null, pending: '', message: '', reveal: 0 },
  preferences: {
    avatar: 'drop:coral', shortcut: 'Ctrl+Alt+M', shortcutActive: true,
    recordingMode: 'dictation', languages: [...RECOGNITION_LANGUAGES],
  },
  update: { current: '', enabled: false, phase: 'idle', message: '', progress: 0, version: '' },
};
const phaseText = { idle: '待机', preparing: '正在打开麦克风', recording: '录音中', finishing: '正在转写' };
type Pane = 'settings' | 'transcript' | null;

function PanelTransition({ open, id, children }: { open: boolean; id?: string; children: ReactNode }) {
  return <div className="panel-transition" id={id} inert={!open}>{children}</div>;
}

function App({ dictation, preferences, update }: DesktopSnapshot) {
  const [pane, setPane] = useState<Pane>(null);
  const [languagesOpen, setLanguagesOpen] = useState(false);
  const [dismissed, setDismissed] = useState('');
  const shell = useRef<HTMLElement>(null);
  const liveText = useRef<HTMLDivElement>(null);
  const { levels, lines, draft } = useCapture(dictation);
  const { phase, pending, message, reveal } = dictation;
  const busy = phase !== 'idle';
  const recording = phase === 'recording';
  const canStop = recording || phase === 'preparing';
  const meeting = preferences.recordingMode === 'meeting';
  const updateBlocked = busy ? '本次听写完成后可安装' : pending ? '请先写入或复制本次转写' : '';
  useLayoutEffect(() => {
    const element = shell.current!;
    const observer = new ResizeObserver(() => {
      const bottomPadding = Number.parseFloat(getComputedStyle(document.body).paddingBottom);
      desktop.resize(element.getBoundingClientRect().bottom + bottomPadding);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (reveal && pending) setPane('transcript');
  }, [reveal, pending]);
  useEffect(() => desktop.onLanguagePanel(setLanguagesOpen), []);
  useEffect(() => {
    if (pane === 'transcript' && liveText.current) liveText.current.scrollTop = liveText.current.scrollHeight;
  }, [pane, lines, draft]);
  useEffect(() => {
    if (!message || pending) return;
    const timer = window.setTimeout(() => void desktop.clearMessage(), 7000);
    return () => window.clearTimeout(timer);
  }, [message, pending]);

  function togglePane(value: Exclude<Pane, null>) {
    if (languagesOpen) void desktop.closeLanguagePanel();
    setPane(old => old === value ? null : value);
  }
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || !pane) return;
      event.preventDefault();
      if (languagesOpen) void desktop.closeLanguagePanel();
      else setPane(null);
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [languagesOpen, pane]);

  const label = phase === 'preparing' ? '取消准备' : recording ? '结束录音并写入' : phase === 'finishing' ? '正在转写'
    : pending ? '查看待写入文字' : meeting ? '会议录音待接入' : '开始听写';
  const { color } = botAvatarChoice(preferences.avatar);
  const palette = botAvatarColors.find(item => item.id === color)!;
  return <section className="shell" ref={shell} aria-label="EchoBuddy 听写浮窗" data-phase={phase}
    onPointerDown={event => {
      if (languagesOpen && event.target instanceof Element && !event.target.closest('.language-selector')) void desktop.closeLanguagePanel();
    }} style={{
    '--accent': palette.lo, '--tint': palette.soft,
    '--power-ink': color === 'yellow' ? palette.deep : 'white',
  } as CSSProperties}>
    <div className="bar">
      <div className="tools">
        <BotAvatar avatar={preferences.avatar} motionId="echobuddy-dictation"
          activity={recording ? 'working' : busy ? 'thinking' : 'idle'} />
        <div className="meter" role="img" aria-label={phaseText[phase]}>
          {levels.map((value, i) => <i key={i} style={{
            height: (recording ? 3 + Math.min(1, value ** 0.65) * 24 : 3) + 'px', opacity: 0.35 + i / 40,
          }} />)}
        </div>
        <button type="button" className="tool" aria-label="设置" title="设置" aria-expanded={pane === 'settings'} aria-controls="settings-panel"
          onClick={() => togglePane('settings')}><GearSix size={21} /></button>
        <button type="button" className="tool" aria-label="转写气泡" title="显示或收起转写" aria-expanded={pane === 'transcript'} aria-controls="transcript-panel"
          onClick={() => togglePane('transcript')}><ChatCircleDots size={22} /></button>
      </div>
      <button type="button" className="power" disabled={phase === 'finishing'} aria-label={label}
        title={label + ' · ' + preferences.shortcut} onClick={() => void desktop.toggle()}>
        {canStop ? <Stop size={19} weight="fill" /> : <Microphone size={22} weight="bold" />}
      </button>
    </div>
    <PanelTransition id="settings-panel" open={pane === 'settings'}>
      <div className="panel inline-settings" onScroll={() => { if (languagesOpen) void desktop.closeLanguagePanel(); }}>
        <div className="row inline-settings-heading">
          <h2>设置</h2>
          <button type="button" className="more-settings-button" title="打开更多设置" onClick={() => void desktop.openSettings()}>
            更多设置 <ArrowUpRight size={13} aria-hidden="true" />
          </button>
        </div>
        <section className="settings-section settings-inline-row">
          <h3>录音模式</h3>
          <RecordingOptions mode={preferences.recordingMode} busy={busy} />
        </section>
        <section className="settings-section settings-inline-row">
          <h3>写入时机</h3>
          <WriteOptions />
        </section>
        <section className="settings-section settings-inline-row">
          <h3>识别语言</h3>
          <LanguageSelector languages={preferences.languages} open={languagesOpen} />
        </section>
        <UpdateSettings update={update} blocked={updateBlocked} />
      </div>
    </PanelTransition>
    <PanelTransition id="transcript-panel" open={pane === 'transcript'}>
      <div className="panel transcript">
        <div className="row"><strong>本次转写</strong></div>
        <div className="words" ref={liveText} role="log" aria-live="polite">
          {pending ? <p>{pending}</p> : <>{lines.map((line, i) => <p key={i}>{line}</p>)}{draft && <p className="draft">{draft}</p>}</>}
          {!pending && !lines.length && !draft && <p className="empty">{busy ? '等待语音…' : '暂无转写内容'}</p>}
        </div>
        {pending && <div className="recover">
          <button onClick={() => void desktop.insertPending()}>写入当前光标</button>
          <button onClick={() => void desktop.copyPending()}>复制文字</button>
        </div>}
      </div>
    </PanelTransition>
    {!busy && message && <PanelTransition open={pane !== 'settings' || meeting}>
      <div className="message" role="status">
        <span>{message}</span><button aria-label="收起听写提示" onClick={() => void desktop.clearMessage()}><X size={14} /></button>
      </div>
    </PanelTransition>}
    {!busy && !pending && !message && update.phase === 'ready' && dismissed !== update.version &&
      <PanelTransition open={pane === null}>
        <UpdateNotice version={update.version} open={() => void desktop.openSettings('updates')} dismiss={() => setDismissed(update.version)} />
      </PanelTransition>}
  </section>;
}

const params = new URLSearchParams(window.location.search);
const view = params.get('view');
if (view === 'settings') document.body.classList.add('settings-host');
if (view === 'languages') document.body.classList.add('language-panel-host');

function Root() {
  const [snapshot, setSnapshot] = useState(initial);
  useEffect(() => {
    const subscriptions = [
      desktop.onDictation(value => setSnapshot(old => ({ ...old, dictation: value }))),
      desktop.onPreferences(value => setSnapshot(old => ({ ...old, preferences: value }))),
      desktop.onUpdate(value => setSnapshot(old => ({ ...old, update: value }))),
    ];
    void desktop.snapshot().then(setSnapshot);
    return () => subscriptions.forEach(unsubscribe => unsubscribe());
  }, []);
  if (view === 'settings') return <SettingsWindow {...snapshot} />;
  if (view === 'languages') return <LanguagePanel preferences={snapshot.preferences}
    placement={params.get('placement') === 'above' ? 'above' : 'below'} tip={Number(params.get('tip')) || 0} />;
  return <App {...snapshot} />;
}

createRoot(document.getElementById('root')!).render(<Root />);
