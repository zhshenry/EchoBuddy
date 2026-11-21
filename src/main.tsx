import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { CaretDown, CaretLeft, CaretRight, ChatCircleDots, Circle, GearSix, Microphone, Stop, X } from '@phosphor-icons/react';
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
  dictation: { phase: 'idle', sessionId: null, recordingStartedAt: null, pending: '', message: '', reveal: 0 },
  preferences: {
    avatar: 'drop:coral', shortcut: 'Ctrl+Alt+M', shortcutActive: true,
    recordingMode: 'dictation', writeTiming: 'sentence', languages: [...RECOGNITION_LANGUAGES], dockOnEdge: true,
  },
  update: { current: '', enabled: false, phase: 'idle', message: '', progress: 0, version: '' },
  dock: null,
};
const phaseText = { idle: '待机', preparing: '正在打开麦克风', recording: '录音中', finishing: '正在转写' };
type Pane = 'settings' | 'transcript' | null;

function PanelTransition({ open, id, children }: { open: boolean; id?: string; children: ReactNode }) {
  return <div className="panel-transition" id={id} inert={!open}>{children}</div>;
}

function DockClock({ startedAt }: { startedAt: number }) {
  const [time, setTime] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setTime(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((time - startedAt) / 1000));
  const elapsed = [Math.floor(seconds / 60), seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
  return <span className="dock-status" title={'已录音 ' + elapsed}><Circle size={6} weight="fill" aria-hidden="true" />{elapsed}</span>;
}

function App({ dictation, preferences, update, dock }: DesktopSnapshot) {
  const [pane, setPane] = useState<Pane>(null);
  const [languagesOpen, setLanguagesOpen] = useState(false);
  const [dismissed, setDismissed] = useState('');
  const shell = useRef<HTMLElement>(null);
  const liveText = useRef<HTMLDivElement>(null);
  const { levels, lines, draft } = useCapture(dictation, preferences.writeTiming);
  const { phase, pending, message, reveal, recordingStartedAt } = dictation;
  const busy = phase !== 'idle';
  const recording = phase === 'recording';
  const canStop = recording || phase === 'preparing';
  const meeting = preferences.recordingMode === 'meeting';
  const compact = dock?.compact === true;
  const motion = dock?.motion;
  const panelOpen = pane !== null;
  const updateBlocked = busy ? '本次听写完成后可安装' : pending ? '请先写入或复制本次转写' : '';
  useLayoutEffect(() => {
    document.body.classList.toggle('compact-overlay', compact);
    const element = shell.current;
    if (motion && window.matchMedia('(prefers-reduced-motion: reduce)').matches) desktop.finishDockMotion(motion.id);
    if (compact || motion || !element) return;
    const observer = new ResizeObserver(() => {
      const bottomPadding = Number.parseFloat(getComputedStyle(document.body).paddingBottom);
      desktop.resize(element.getBoundingClientRect().bottom + bottomPadding);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [compact, motion]);
  useEffect(() => { void desktop.setOverlayPanelOpen(panelOpen); }, [panelOpen]);
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
    : meeting ? '会议录音待接入' : '开始听写';
  const { color } = botAvatarChoice(preferences.avatar);
  const palette = botAvatarColors.find(item => item.id === color)!;
  const theme = {
    '--accent': palette.lo, '--tint': palette.soft, '--power-ink': color === 'yellow' ? palette.deep : 'white',
  } as CSSProperties;
  const avatar = <BotAvatar avatar={preferences.avatar} motionId="echobuddy-dictation"
    activity={recording ? 'working' : busy ? 'thinking' : 'idle'} />;
  const recordButton = (small: boolean) => <button type="button" className="power" disabled={phase === 'finishing'} aria-label={label}
    title={label + ' · ' + preferences.shortcut} onClick={() => void desktop.toggle()}>
    {canStop || (small && phase === 'finishing') ? <Stop size={small ? 16 : 19} weight="fill" />
      : <Microphone size={small ? 19 : 22} weight="bold" />}
  </button>;
  const Caret = dock?.side === 'top' ? CaretDown : dock?.side === 'left' ? CaretRight : CaretLeft;
  const compactBar = dock && (compact || motion)
    ? <section className="edge-dock" role="group" aria-label="EchoBuddy 贴边听写" data-side={dock.side} data-phase={phase} inert={!compact}>
      <button type="button" className="dock-avatar" aria-label="展开 EchoBuddy" title="展开 EchoBuddy" onClick={() => void desktop.expandOverlay()}>
        {avatar}
      </button>
      {phase === 'idle' ? <button type="button" className="dock-arrow" aria-label="展开完整浮窗" title="展开完整浮窗"
        onClick={() => void desktop.expandOverlay()}><Caret size={15} weight="bold" aria-hidden="true" /></button>
        : recording && recordingStartedAt !== null ? <DockClock startedAt={recordingStartedAt} />
        : <span className="dock-status" role="status">{phase === 'preparing' ? '准备中' : '转写中'}</span>}
      {recordButton(true)}
    </section> : null;
  const expandedBar = compact && !motion ? null : <section className="shell" ref={shell} aria-label="EchoBuddy 听写浮窗" data-phase={phase} inert={compact}
    onPointerDown={event => {
      if (languagesOpen && event.target instanceof Element && !event.target.closest('.language-selector')) void desktop.closeLanguagePanel();
    }}>
    <div className="bar">
      <div className="tools">
        {avatar}
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
      {recordButton(false)}
    </div>
    <PanelTransition id="settings-panel" open={pane === 'settings'}>
      <div className="panel inline-settings" onScroll={() => { if (languagesOpen) void desktop.closeLanguagePanel(); }}>
        <div className="row inline-settings-heading">
          <h2>设置</h2>
          <button type="button" className="more-settings-button" title="打开更多设置" onClick={() => void desktop.openSettings()}>
            更多设置 <GearSix size={13} aria-hidden="true" />
          </button>
        </div>
        <section className="settings-section settings-inline-row">
          <h3>录音模式</h3>
          <RecordingOptions mode={preferences.recordingMode} busy={busy} />
        </section>
        <section className="settings-section settings-inline-row">
          <h3>写入时机</h3>
          <WriteOptions timing={preferences.writeTiming} busy={busy} />
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
        <UpdateNotice version={update.version} install={() => void desktop.installUpdate()} dismiss={() => setDismissed(update.version)} />
      </PanelTransition>}
  </section>;

  const compactBounds = motion?.compact ?? dock?.compactBounds;
  const style = {
    ...theme,
    ...(compactBounds && {
      '--dock-compact-x': `${compactBounds.x}px`, '--dock-compact-y': `${compactBounds.y}px`,
      '--dock-compact-width': `${compactBounds.width}px`, '--dock-compact-height': `${compactBounds.height}px`,
    }),
    ...(motion && {
      '--dock-expanded-x': `${motion.expanded.x}px`, '--dock-expanded-y': `${motion.expanded.y}px`,
      '--dock-expanded-width': `${motion.expanded.width}px`, '--dock-expanded-height': `${motion.expanded.height}px`,
    }),
  } as CSSProperties;
  return <div className={motion ? 'overlay dock-motion' : 'overlay'} data-compact={compact}
    data-side={dock?.side} data-phase={phase} style={style}
    onTransitionEnd={motion ? event => {
      if (event.target === event.currentTarget && event.propertyName === '--dock-progress' &&
        Number(getComputedStyle(event.currentTarget).getPropertyValue('--dock-progress')) === (compact ? 0 : 1)) {
        desktop.finishDockMotion(motion.id);
      }
    } : undefined}>
    <div className={motion ? 'dock-motion-surface' : undefined}>
      {compactBar}
      {expandedBar}
    </div>
  </div>;
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
      desktop.onOverlayDock(value => setSnapshot(old => ({ ...old, dock: value }))),
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
