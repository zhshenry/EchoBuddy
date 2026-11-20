import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatCircleDots, GearSix, Microphone, PencilSimple, Stop, X } from '@phosphor-icons/react';
import { botAvatarChoice, botAvatarColors } from '../shared/bot-avatar';
import type { DesktopSnapshot } from '../shared/desktop';
import { BotAvatar } from './avatars/BotAvatar';
import { useCapture } from './audio/useCapture';
import { AvatarPicker } from './widget/AvatarPicker';
import { UpdateNotice, UpdateSettings } from './widget/UpdateSettings';
import './avatars/avatar.css';
import './widget/widget.css';

const desktop = window.echoBuddy;
const initial: DesktopSnapshot = {
  dictation: { phase: 'idle', sessionId: null, pending: '', message: '', reveal: 0 },
  preferences: { avatar: 'drop:coral', shortcut: 'Ctrl+Alt+M', shortcutActive: true },
  update: { current: '', enabled: false, phase: 'idle', message: '', progress: 0, version: '' },
};
const phaseText = { idle: '待机', preparing: '正在打开麦克风', recording: '录音中', finishing: '正在转写' };
type Pane = 'settings' | 'transcript' | null;

function combination(event: KeyboardEvent): string {
  const key = event.code.replace(/^(Key|Digit)/, '');
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|Space)$/.test(key)) return '';
  if (!(event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || /^F\d/.test(key))) return '';
  return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Win', key].filter(Boolean).join('+');
}

function PanelTransition({ open, id, children }: { open: boolean; id?: string; children: ReactNode }) {
  return <div className="panel-transition" id={id} inert={!open}>{children}</div>;
}

function App() {
  const [{ dictation, preferences, update }, setSnapshot] = useState(initial);
  const [pane, setPane] = useState<Pane>(null);
  const [binding, setBinding] = useState(false);
  const [bindingError, setBindingError] = useState('');
  const [dismissed, setDismissed] = useState('');
  const shell = useRef<HTMLElement>(null);
  const liveText = useRef<HTMLDivElement>(null);
  const { levels, lines, draft } = useCapture(dictation);
  const { phase, pending, message, reveal } = dictation;
  const busy = phase !== 'idle';
  const recording = phase === 'recording';
  const canStop = recording || phase === 'preparing';
  const updateBlocked = busy ? '本次听写完成后可安装' : pending ? '请先写入或复制本次转写' : binding ? '请先完成快捷键设置' : '';

  useEffect(() => {
    const subscriptions = [
      desktop.onDictation(value => setSnapshot(old => ({ ...old, dictation: value }))),
      desktop.onPreferences(value => setSnapshot(old => ({ ...old, preferences: value }))),
      desktop.onUpdate(value => setSnapshot(old => ({ ...old, update: value }))),
      desktop.onShortcutCancelled(() => setBinding(false)),
    ];
    void desktop.snapshot().then(setSnapshot);
    return () => subscriptions.forEach(unsubscribe => unsubscribe());
  }, []);
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
  useEffect(() => {
    if (pane === 'transcript' && liveText.current) liveText.current.scrollTop = liveText.current.scrollHeight;
  }, [pane, lines, draft]);
  useEffect(() => {
    if (!message || pending) return;
    const timer = window.setTimeout(() => void desktop.clearMessage(), 7000);
    return () => window.clearTimeout(timer);
  }, [message, pending]);

  function cancelBinding() {
    if (!binding) return;
    setBinding(false);
    void desktop.finishShortcut();
  }
  function togglePane(value: Exclude<Pane, null>) {
    cancelBinding();
    setPane(old => old === value ? null : value);
  }
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.repeat || event.isComposing) return;
      if (event.key === 'Escape') {
        if (binding) { event.preventDefault(); cancelBinding(); }
        else if (pane) { event.preventDefault(); setPane(null); }
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
  }, [binding, pane]);

  async function editShortcut() {
    setBindingError('');
    if (binding) { cancelBinding(); return; }
    if (await desktop.beginShortcut()) setBinding(true);
  }

  const label = phase === 'preparing' ? '取消准备' : recording ? '结束录音并写入' : phase === 'finishing' ? '正在转写'
    : pending ? '查看待写入文字' : '开始听写';
  const { color } = botAvatarChoice(preferences.avatar);
  const palette = botAvatarColors.find(item => item.id === color)!;
  return <section className="shell" ref={shell} aria-label="EchoBuddy 听写浮窗" data-phase={phase}>
    <div className="bar" style={{
      '--accent': palette.lo, '--tint': palette.soft,
      '--power-ink': color === 'yellow' ? palette.deep : 'white',
    } as CSSProperties}>
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
      <button type="button" className="power" disabled={phase === 'finishing' || binding} aria-label={label}
        title={label + ' · ' + preferences.shortcut} onClick={() => void desktop.toggle()}>
        {canStop ? <Stop size={19} weight="fill" /> : <Microphone size={22} weight="bold" />}
      </button>
    </div>
    <PanelTransition id="settings-panel" open={pane === 'settings'}>
      <div className="panel settings">
        <div className="row">
          <strong>听写快捷键</strong>
          <button className="key-button" aria-label="修改快捷键" aria-pressed={binding} disabled={busy} onClick={() => void editShortcut()}>
            {binding ? '按下新组合键' : <span className="keys">{preferences.shortcut.split('+').map(key => <kbd key={key}>{key}</kbd>)}</span>}
            <PencilSimple size={14} />
          </button>
        </div>
        {(bindingError || (!binding && !preferences.shortcutActive)) &&
          <p className="shortcut-error" role="status">{bindingError || '快捷键已被占用，请换一组。'}</p>}
        <AvatarPicker avatar={preferences.avatar} />
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
    {!busy && message && <PanelTransition open={pane !== 'settings'}>
      <div className="message" role="status">
        <span>{message}</span><button aria-label="收起听写提示" onClick={() => void desktop.clearMessage()}><X size={14} /></button>
      </div>
    </PanelTransition>}
    {!updateBlocked && !message && update.phase === 'ready' && dismissed !== update.version &&
      <PanelTransition open={pane === null}>
        <UpdateNotice version={update.version} open={() => setPane('settings')} dismiss={() => setDismissed(update.version)} />
      </PanelTransition>}
  </section>;
}

createRoot(document.getElementById('root')!).render(<App />);
