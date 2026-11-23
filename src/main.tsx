import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { CaretDown, CaretLeft, CaretRight, ChatCircleDots, Circle, GearSix, Microphone, Stop, X } from '@phosphor-icons/react';
import { botAvatarChoice, botAvatarColors } from '../shared/bot-avatar';
import { DEFAULT_SHORTCUTS, type DesktopSnapshot } from '../shared/desktop';
import { initialMeetingCapture } from '../shared/meeting-contracts';
import { RECOGNITION_LANGUAGES } from '../shared/speech-contracts';
import { BotAvatar } from './avatars/BotAvatar';
import { useCapture } from './audio/useCapture';
import { SettingsWindow } from './widget/SettingsWindow';
import { LanguagePanel, LanguageSelector, MeetingSourceOptions, RecordingOptions, WriteOptions } from './widget/SpeechOptions';
import { UpdateNotice, UpdateSettings } from './widget/UpdateSettings';
import './avatars/avatar.css';
import './widget/widget.css';
import './widget/meeting.css';

const desktop = window.echoBuddy;
const initial: DesktopSnapshot = {
  dictation: { phase: 'idle', sessionId: null, recordingStartedAt: null, pending: '', message: '', reveal: 0, clearRevision: 0 },
  meeting: initialMeetingCapture,
  preferences: {
    avatar: 'drop:coral', shortcuts: { ...DEFAULT_SHORTCUTS }, shortcutActive: { dictation: true, meeting: true },
    recordingMode: 'dictation', writeTiming: 'sentence', meetingSources: ['microphone'], languages: [...RECOGNITION_LANGUAGES], dockOnEdge: true,
  },
  update: { current: '', enabled: false, phase: 'idle', message: '', progress: 0, version: '' },
  dock: null,
};
const phaseText = { idle: '待机', preparing: '正在打开麦克风', recording: '录音中', finishing: '正在转写' };
const meetingPhaseText = { idle: '会议录音', preparing: '准备中', recording: '录音中', saving: '保存中' };
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
  return <span className="dock-status" data-long={seconds >= 6000} title={'已录音 ' + elapsed}><Circle size={6} weight="fill" aria-hidden="true" />{elapsed}</span>;
}

function App({ dictation, meeting: capture, preferences, update, dock }: DesktopSnapshot) {
  const [pane, setPane] = useState<Pane>(null);
  const [languagesOpen, setLanguagesOpen] = useState(false);
  const [writingPending, setWritingPending] = useState(false);
  const [dismissed, setDismissed] = useState('');
  const shell = useRef<HTMLElement>(null);
  const measureShell = useRef<(refresh?: boolean) => void>(null);
  const liveText = useRef<HTMLDivElement>(null);
  const dockPress = useRef<{ id: number; target: Element; x: number; y: number;
    screenX: number; screenY: number; dragging: boolean } | null>(null);
  const suppressDockClick = useRef(false);
  const { levels, lines, draft } = useCapture(dictation, preferences.writeTiming);
  const { pending, message, reveal, clearRevision } = dictation;
  const previousClearRevision = useRef(clearRevision);
  const hasTranscript = Boolean(pending || lines.length || draft);
  const mode = capture.phase !== 'idle' ? 'meeting' : dictation.phase !== 'idle' ? 'dictation' : preferences.recordingMode;
  const meeting = mode === 'meeting';
  const phase = meeting ? (capture.phase === 'saving' ? 'finishing' : capture.phase) : dictation.phase;
  const recordingStartedAt = meeting ? capture.startedAt : dictation.recordingStartedAt;
  const busy = phase !== 'idle';
  const recording = phase === 'recording';
  const canStop = recording || phase === 'preparing';
  const compact = dock?.compact === true;
  const motion = dock?.motion;
  const dockInset = dock?.layout.expanded.y;
  const panelOpen = pane !== null;
  const updateBlocked = busy ? (meeting ? '会议录音保存后可安装' : '本次听写完成后可安装') : pending ? '请先写入或复制本次转写' : '';
  useLayoutEffect(() => {
    document.body.classList.toggle('compact-overlay', compact);
    const element = shell.current;
    if (motion && window.matchMedia('(prefers-reduced-motion: reduce)').matches) desktop.finishDockMotion(motion);
    if (compact || motion || !element) return;
    const { paddingTop, paddingBottom } = getComputedStyle(document.body);
    const gutters = Number.parseFloat(paddingTop) + Number.parseFloat(paddingBottom);
    let targetHeight = 0;
    let reservedHeight = 0;
    let request = 0;
    const measure = (refresh = false) => {
      const visible = element.getBoundingClientRect().height + gutters;
      let final = visible;
      for (const panel of element.querySelectorAll<HTMLElement>(':scope > .panel-transition')) {
        final -= panel.getBoundingClientRect().height;
        if (!panel.inert) final += panel.firstElementChild!.getBoundingClientRect().height;
      }
      const target = Math.ceil(final);
      // Make room before revealing a panel and keep that space until it has closed.
      const rendered = Math.ceil(visible);
      const reserved = rendered === target ? target : Math.max(reservedHeight, rendered, target);
      if (!refresh && target === targetHeight && reserved === reservedHeight) return;
      targetHeight = target;
      reservedHeight = reserved;
      const id = ++request;
      void desktop.resize(reserved).then(placement => {
        if (id !== request || !placement) return;
        element.style.setProperty('--panel-room', `${placement.room}px`);
        element.style.setProperty('--panel-inset', `${placement.inset}px`);
      });
    };
    measureShell.current = measure;
    const observer = new ResizeObserver(() => measure());
    observer.observe(element);
    return () => {
      observer.disconnect();
      measureShell.current = null;
      request++;
      element.style.removeProperty('--panel-room');
      element.style.removeProperty('--panel-inset');
    };
  }, [compact, motion]);
  useLayoutEffect(() => { measureShell.current?.(true); }, [pane, dockInset]);
  useEffect(() => { void desktop.setOverlayPanelOpen(panelOpen); }, [panelOpen]);
  useEffect(() => {
    if (reveal && pending) setPane('transcript');
  }, [reveal, pending]);
  useEffect(() => {
    const cleared = previousClearRevision.current !== clearRevision;
    previousClearRevision.current = clearRevision;
    if (meeting && !pending && !cleared) setPane(previous => previous === 'transcript' ? null : previous);
  }, [meeting, pending, clearRevision]);
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
  function beginDockPress(event: PointerEvent<HTMLElement>) {
    if (motion || !event.isPrimary || event.button !== 0 || !(event.target instanceof Element)) return;
    const target = event.target.closest('button');
    if (!target) return;
    target.setPointerCapture(event.pointerId);
    suppressDockClick.current = false;
    dockPress.current = { id: event.pointerId, target, x: event.clientX, y: event.clientY,
      screenX: event.screenX, screenY: event.screenY, dragging: false };
  }
  function moveDockPress(event: PointerEvent<HTMLElement>) {
    const press = dockPress.current;
    if (!press || press.id !== event.pointerId || press.dragging ||
        Math.hypot(event.screenX - press.screenX, event.screenY - press.screenY) < 4) return;
    press.dragging = true;
    press.target = event.currentTarget;
    event.currentTarget.setPointerCapture(event.pointerId);
    suppressDockClick.current = true;
    desktop.dragCompact({ x: press.x, y: press.y });
  }
  function endDockPress(event: PointerEvent<HTMLElement>) {
    const press = dockPress.current;
    if (!press || press.id !== event.pointerId ||
        (event.type === 'lostpointercapture' && press.target !== event.target)) return;
    dockPress.current = null;
    if (press.dragging) desktop.dragCompact(null);
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

  const label = phase === 'preparing' ? '取消准备'
    : recording ? (meeting ? '停止会议录音' : '结束录音并写入')
    : phase === 'finishing' ? (meeting ? '正在保存录音' : '正在转写')
    : meeting ? '开始会议录音' : '开始听写';
  const { color } = botAvatarChoice(preferences.avatar);
  const palette = botAvatarColors.find(item => item.id === color)!;
  const theme = {
    '--accent': palette.lo, '--tint': palette.soft, '--power-ink': color === 'yellow' ? palette.deep : 'white',
  } as CSSProperties;
  const avatar = <BotAvatar avatar={preferences.avatar} motionId="echobuddy-dictation"
    activity={recording ? 'working' : busy ? 'thinking' : 'idle'} />;
  const recordTitle = preferences.shortcutActive[mode] ? label + ' · ' + preferences.shortcuts[mode] : label;
  const recordButton = (small: boolean) => <button type="button" className="power" disabled={phase === 'finishing'} aria-label={label}
    title={recordTitle} onClick={() => void desktop.toggle()}>
    {canStop || ((small || meeting) && phase === 'finishing') ? <Stop size={small ? 16 : 19} weight="fill" />
      : <Microphone size={small ? 19 : 22} weight="bold" />}
  </button>;
  const Caret = dock?.side === 'top' ? CaretDown : dock?.side === 'left' ? CaretRight : CaretLeft;
  const compactBar = dock && (compact || motion)
    ? <section className="edge-dock" role="group" aria-label={meeting ? 'EchoBuddy 贴边会议录音' : 'EchoBuddy 贴边听写'}
      data-side={dock.side} data-phase={phase} inert={!compact}
      onPointerDown={beginDockPress} onPointerMove={moveDockPress} onPointerUp={endDockPress}
      onPointerCancel={endDockPress} onLostPointerCapture={endDockPress} onClickCapture={event => {
        if (event.detail > 0 && suppressDockClick.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}>
      <button type="button" className="dock-avatar" aria-label="展开 EchoBuddy" title="展开 EchoBuddy" onClick={() => void desktop.expandOverlay()}>
        {avatar}
      </button>
      {phase === 'idle' ? <button type="button" className="dock-arrow" aria-label="展开完整浮窗" title="展开完整浮窗"
        onClick={() => void desktop.expandOverlay()}><Caret size={15} weight="bold" aria-hidden="true" /></button>
        : recording && recordingStartedAt !== null ? <DockClock startedAt={recordingStartedAt} />
        : <span className="dock-status" role="status">{phase === 'preparing' ? '准备中' : meeting ? '保存中' : '转写中'}</span>}
      {recordButton(true)}
    </section> : null;
  const expandedBar = compact && !motion ? null : <section className="shell" ref={shell}
    aria-label={meeting ? 'EchoBuddy 会议录音浮窗' : 'EchoBuddy 听写浮窗'} data-phase={phase} inert={compact}
    onPointerDown={event => {
      if (languagesOpen && event.target instanceof Element && !event.target.closest('.language-selector')) void desktop.closeLanguagePanel();
    }}>
    <div className="bar">
      <div className="tools">
        {avatar}
        <div className="recording-mode-swap recording-mode-status">
          <div className="meter" role="img" aria-label={phaseText[dictation.phase]} inert={meeting}>
            {levels.map((value, i) => <i key={i} style={{
              height: (dictation.phase === 'recording' ? 3 + Math.min(1, value ** 0.65) * 24 : 3) + 'px', opacity: 0.35 + i / 40,
            }} />)}
          </div>
          <div className="meeting-indicator" inert={!meeting}>
            <span role="status">{meetingPhaseText[capture.phase]}</span>
            {meeting && recording && recordingStartedAt !== null && <DockClock startedAt={recordingStartedAt} />}
          </div>
        </div>
        <button type="button" className="tool" aria-label="设置" title="设置" aria-expanded={pane === 'settings'} aria-controls="settings-panel"
          onClick={() => togglePane('settings')}><GearSix size={21} /></button>
        <button type="button" className="tool"
          aria-label={meeting ? '打开会议记录' : '转写气泡'} title={meeting ? '打开会议记录' : '显示或收起转写'}
          aria-expanded={meeting ? undefined : pane === 'transcript'} aria-controls={meeting ? undefined : 'transcript-panel'}
          onClick={() => {
            if (meeting) void desktop.openMeeting();
            else togglePane('transcript');
          }}><ChatCircleDots size={22} aria-hidden="true" /></button>
      </div>
      {recordButton(false)}
    </div>
    <PanelTransition id="settings-panel" open={pane === 'settings'}>
      <div className="panel inline-settings" onScroll={() => { if (languagesOpen) void desktop.closeLanguagePanel(); }}>
        <div className="row inline-settings-heading">
          <h2>设置</h2>
          <button type="button" className="more-settings-button" title="打开更多设置" onClick={() => {
            setPane(null);
            void desktop.openSettings();
          }}>
            更多设置 <GearSix size={13} aria-hidden="true" />
          </button>
        </div>
        <section className="settings-section settings-inline-row">
          <h3>录音模式</h3>
          <RecordingOptions mode={mode} busy={busy} />
        </section>
        <section className="settings-section recording-mode-swap recording-mode-details">
          <div className="settings-inline-row" inert={meeting}>
            <h3>写入时机</h3>
            <WriteOptions timing={preferences.writeTiming} busy={busy} />
          </div>
          <div className="settings-inline-row" inert={!meeting}>
            <h3>录音来源</h3>
            <MeetingSourceOptions sources={meeting && busy ? capture.sources : preferences.meetingSources} busy={busy} />
          </div>
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
        <div className="row">
          <strong>本次转写</strong>
          <button type="button" className="transcript-clear" aria-label="清空本次转写"
            disabled={busy || writingPending || !hasTranscript} onClick={() => void desktop.clearTranscript()}>清空</button>
        </div>
        <div className="words" ref={liveText} role="log" aria-live="polite">
          {pending ? <p>{pending}</p> : <>{lines.map((line, i) => <p key={i}>{line}</p>)}{draft && <p className="draft">{draft}</p>}</>}
          {!hasTranscript && <p className="empty">{busy ? '等待语音…' : '暂无转写内容'}</p>}
        </div>
        {pending && <div className="recover">
          <button type="button" disabled={writingPending} onClick={() => {
            setWritingPending(true);
            void desktop.insertPending().finally(() => setWritingPending(false));
          }}>写入当前光标</button>
          <button type="button" disabled={writingPending} onClick={() => void desktop.copyPending()}>复制文字</button>
        </div>}
      </div>
    </PanelTransition>
    {!busy && message && <PanelTransition open={pane !== 'settings' && !capture.message}>
      <div className="message" role="status">
        <span>{message}</span><button aria-label="收起听写提示" onClick={() => void desktop.clearMessage()}><X size={14} /></button>
      </div>
    </PanelTransition>}
    {capture.message && <div className="message meeting-notice">
      <span role="status">{capture.message}</span>
      {capture.latestId && <button type="button" className="meeting-link"
        onClick={() => { if (capture.latestId) void desktop.openMeeting(capture.latestId); }}>查看会议</button>}
      <button type="button" className="dismiss-meeting-notice" aria-label="收起会议录音提示"
        onClick={() => void desktop.clearMeetingNotice()}><X size={14} /></button>
    </div>}
    {!busy && !pending && !message && !capture.message && update.phase === 'ready' && dismissed !== update.version &&
      <PanelTransition open={pane === null}>
        <UpdateNotice version={update.version} install={() => void desktop.installUpdate()} dismiss={() => setDismissed(update.version)} />
      </PanelTransition>}
  </section>;

  const layout = dock?.layout;
  const style = {
    ...theme,
    ...(layout && {
      '--dock-compact-x': `${layout.compact.x}px`, '--dock-compact-y': `${layout.compact.y}px`,
      '--dock-compact-width': `${layout.compact.width}px`, '--dock-compact-height': `${layout.compact.height}px`,
      '--dock-expanded-x': `${layout.expanded.x}px`, '--dock-expanded-y': `${layout.expanded.y}px`,
      '--dock-expanded-width': `${layout.expanded.width}px`, '--dock-expanded-height': `${layout.expanded.height}px`,
    }),
  } as CSSProperties;
  return <div className={motion ? 'overlay dock-motion' : 'overlay'} data-compact={compact}
    data-side={dock?.side} data-phase={phase} style={style}
    onTransitionEnd={motion ? event => {
      if (event.target === event.currentTarget && event.propertyName === '--dock-progress' &&
        Number(getComputedStyle(event.currentTarget).getPropertyValue('--dock-progress')) === (compact ? 0 : 1)) {
        desktop.finishDockMotion(motion);
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
      desktop.onMeetingCapture(value => setSnapshot(old => ({ ...old, meeting: value }))),
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
