import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { DotsThree, PencilSimple } from '@phosphor-icons/react';
import { encodeSpeechWave } from '../../shared/speech-audio';
import { SPEECH_SAMPLE_RATE } from '../../shared/speech-contracts';
import { VOICEPRINT_CLIP_SECONDS, VOICEPRINT_SAMPLES, type VoiceprintEnrollment, type VoiceprintId, type VoiceprintProfile } from '../../shared/speaker-contracts';
import { Microphone } from '../audio/microphone';
import { useInlineName } from './useInlineName';

const prompts = [
  '我通常会在早上安排好今天要做的事情。',
  '今天的天气不错，我准备出门走一走。',
  '我想把刚想到的点子记下来，晚点再整理。',
  '我刚看完一本书，想和朋友聊聊故事里的细节。',
];
type Recording = {
  microphone: Microphone;
  samples: Float32Array;
  length: number;
  id?: string;
  timer?: number;
  stopping: boolean;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  return '处理失败，请重试。';
}

export function SpeakerSettings({ busy }: { busy: boolean }) {
  const desktop = window.echoBuddy;
  const recording = useRef<Recording | undefined>(undefined);
  const addButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const [profiles, setProfiles] = useState<VoiceprintProfile[]>();
  const [target, setTarget] = useState<VoiceprintEnrollment | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VoiceprintId | null>(null);
  const [deleteError, setDeleteError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [step, setStep] = useState(0);
  const [phase, setPhase] = useState<'preparing' | 'recording' | 'processing' | null>(null);
  const [message, setMessage] = useState('');
  const hasSelf = profiles?.some(profile => profile.id === 'self');
  const locked = !!target || saving;

  const release = useCallback((keepSamples = false) => {
    const current = recording.current;
    recording.current = undefined;
    if (current) {
      window.clearTimeout(current.timer);
      void current.microphone.stop().catch(() => {});
    }
    void desktop.cancelSpeakerCapture(keepSamples).catch(() => {});
  }, [desktop]);

  useEffect(() => {
    let mounted = true;
    void desktop.voiceprints().then(saved => { if (mounted) setProfiles(saved); }).catch(() => {
      if (mounted) setMessage('无法读取声纹库，请重新打开设置。');
    });
    return () => { mounted = false; release(); };
  }, [desktop, release]);

  useLayoutEffect(() => { if (deleteTarget) deleteDialog.current?.showModal(); }, [deleteTarget]);
  useLayoutEffect(() => {
    if (target || deleteTarget || saving || !returnFocus.current) return;
    const button = returnFocus.current.isConnected ? returnFocus.current : addButton.current;
    returnFocus.current = null;
    button?.focus({ preventScroll: true });
  }, [target, deleteTarget, saving]);

  function beginEnrollment(selection: VoiceprintEnrollment, origin: HTMLButtonElement) {
    returnFocus.current = origin;
    setTarget(selection);
    setStep(0);
    setMessage('');
  }

  function cancel() {
    release();
    setPhase(null);
    setMessage('');
    setTarget(null);
  }

  async function stop(current: Recording) {
    if (recording.current !== current || current.stopping || !current.id) return;
    current.stopping = true;
    window.clearTimeout(current.timer);
    setPhase('processing');
    let submitted = false;
    try {
      await current.microphone.stop();
      if (recording.current !== current) return;
      if (!current.length) throw new Error('没有录到声音，请检查麦克风后重试。');
      const wave = encodeSpeechWave(current.samples.subarray(0, current.length));
      submitted = true;
      const result = await desktop.finishSpeakerCapture(current.id, wave);
      if (recording.current !== current || result.type !== 'enrollment') return;
      if (result.saved) {
        setProfiles(result.profiles);
        setTarget(null);
        setMessage('验证通过，已保存本机声纹。');
      } else setStep(result.samples);
    } catch (error) {
      if (recording.current === current) {
        setMessage(errorMessage(error));
        if (!submitted) void desktop.cancelSpeakerCapture(true).catch(() => {});
      }
    } finally {
      if (recording.current === current) {
        recording.current = undefined;
        setPhase(null);
      }
    }
  }

  async function start() {
    if (!target || recording.current || busy || (target.id === 'new' && !target.name.trim())) return;
    const microphone = new Microphone(frame => {
      if (recording.current !== current) return;
      const chunk = frame.subarray(0, current.samples.length - current.length);
      current.samples.set(chunk, current.length);
      current.length += chunk.length;
      if (current.length === current.samples.length) void stop(current);
    }, () => void stop(current), false);
    const current: Recording = { microphone, samples: new Float32Array(VOICEPRINT_CLIP_SECONDS * SPEECH_SAMPLE_RATE), length: 0, stopping: false };
    recording.current = current;
    setMessage('');
    setPhase('preparing');
    try {
      const id = await desktop.beginSpeakerCapture('enroll', target);
      if (recording.current !== current) return;
      if (!id) throw new Error('请先结束当前录音或设置操作，再开始录音。');
      current.id = id;
      await microphone.start();
      if (recording.current !== current || current.stopping) return;
      setPhase('recording');
      current.timer = window.setTimeout(() => void stop(current), VOICEPRINT_CLIP_SECONDS * 1000);
    } catch (error) {
      if (recording.current !== current) return;
      release(true);
      setPhase(null);
      const text = error instanceof DOMException
        ? error.name === 'NotAllowedError' ? '请在 Windows 隐私设置中允许麦克风访问。' : '无法打开麦克风，请检查设备后重试。'
        : errorMessage(error);
      setMessage(text);
    }
  }

  async function deleteProfile() {
    if (!deleteTarget || saving) return;
    setSaving(true);
    setDeleteError(false);
    try {
      setProfiles(await desktop.deleteVoiceprint(deleteTarget));
      setMessage('声纹已删除。');
      deleteDialog.current?.close();
    } catch { setDeleteError(true); }
    finally { setSaving(false); }
  }

  async function renameProfile(id: VoiceprintId, name: string) {
    await desktop.renameVoiceprint(id, name);
    setProfiles(current => current?.map(profile => profile.id === id ? { ...profile, name } : profile));
  }

  const verifying = step === VOICEPRINT_SAMPLES;
  const recordLabel = phase === 'preparing' ? '准备麦克风…' : phase === 'processing' ? '正在处理…' : phase === 'recording' ? '停止录音' : '开始录音';
  return <section className="settings-section" aria-labelledby="voiceprint-heading">
    <div className="row speaker-heading">
      <h2 id="voiceprint-heading">声纹库</h2>
      <div className="speaker-actions">
        {!hasSelf && <button type="button" disabled={!profiles || busy || locked}
          onClick={event => beginEnrollment({ id: 'self' }, event.currentTarget)}>录入我的声纹</button>}
        <button type="button" className="speaker-record" ref={addButton} disabled={!profiles || busy || locked}
          onClick={event => beginEnrollment({ id: 'new', name: '' }, event.currentTarget)}>新增声纹</button>
      </div>
    </div>
    {target && <div className="voiceprint-step">
      <h3 aria-live="polite">{verifying ? '验证声纹' : '录入样本 ' + (step + 1) + ' / ' + VOICEPRINT_SAMPLES}</h3>
      {target.id === 'new' ? <div className="speaker-actions speaker-name-row">
        <label htmlFor="voiceprint-enroll-name">显示名称</label>
        <input id="voiceprint-enroll-name" type="text" autoFocus value={target.name} readOnly={!!phase || step > 0}
          onChange={event => setTarget({ id: 'new', name: event.currentTarget.value })} />
      </div> : <p className="voiceprint-target settings-note">录入对象 {profiles?.find(profile => profile.id === target.id)?.name || '我'}</p>}
      <p className="voiceprint-prompt">{prompts[step]}</p>
      <p className="settings-note">按平常说话的声音读完这句，至少说 3 秒。</p>
      <div className="speaker-actions">
        <button type="button" onClick={cancel}>退出录入</button>
        <button type="button" className="speaker-record" autoFocus={target.id !== 'new'}
          disabled={phase === 'preparing' || phase === 'processing' || (busy && !phase) || (target.id === 'new' && !target.name.trim())}
          onClick={() => phase === 'recording' && recording.current ? void stop(recording.current) : void start()}>{recordLabel}</button>
      </div>
      {phase === 'recording' && <p className="speaker-message" role="status">正在录音…</p>}
    </div>}
    {message && <p className="speaker-message" role="status">{message}</p>}
    {!!profiles?.length && <ul className="voiceprint-list" aria-label="已录入的声纹">
      {profiles.map(profile => <VoiceprintRow key={profile.id} profile={profile} busy={busy} locked={locked}
        onRename={name => renameProfile(profile.id, name)}
        onEnroll={origin => beginEnrollment({ id: profile.id }, origin)} onDelete={origin => {
          returnFocus.current = origin;
          setDeleteTarget(profile.id);
          setDeleteError(false);
        }} />)}
    </ul>}
    <p className="settings-note">声纹加密保存在本机，用于标注会议转写中的说话人。</p>
    <dialog ref={deleteDialog} className="settings-confirm-dialog" role="alertdialog"
      aria-labelledby="voiceprint-delete-title" aria-describedby="voiceprint-delete-description"
      onClose={() => setDeleteTarget(null)} onCancel={event => { if (saving) event.preventDefault(); }}>
      <h3 id="voiceprint-delete-title">删除声纹？</h3>
      <p id="voiceprint-delete-description">将删除「{profiles?.find(profile => profile.id === deleteTarget)?.name || '我'}」的本机声纹。</p>
      {deleteError && <p className="speaker-message" role="alert">无法删除声纹，请重试。</p>}
      <div className="settings-confirm-actions">
        <button type="button" disabled={saving} onClick={() => deleteDialog.current?.close()}>取消</button>
        <button type="button" className="settings-confirm" disabled={saving} onClick={() => void deleteProfile()}>删除声纹</button>
      </div>
    </dialog>
  </section>;
}

function VoiceprintRow({ profile, busy, locked, onRename, onEnroll, onDelete }: {
  profile: VoiceprintProfile;
  busy: boolean;
  locked: boolean;
  onRename: (name: string) => Promise<void>;
  onEnroll: (origin: HTMLButtonElement) => void;
  onDelete: (origin: HTMLButtonElement) => void;
}) {
  const name = profile.name || '我';
  const self = profile.id === 'self';
  const editor = useInlineName(profile.name, onRename, self);
  const errorId = useId();
  const menuId = useId();
  const moreButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  function chooseAction(action: (origin: HTMLButtonElement) => void) {
    const origin = moreButton.current;
    if (!origin) return;
    menu.current?.hidePopover();
    action(origin);
  }

  return <li>
    <div className="row voiceprint-person">
      <div className="voiceprint-person-name">
        {editor.editing ? <input {...editor.inputProps} className="inline-name-control voiceprint-name" aria-label="显示名称"
          placeholder={self ? '我' : undefined} aria-describedby={editor.error ? errorId : undefined} />
          : <button {...editor.buttonProps} className="inline-name-control voiceprint-name" aria-label={`给${name}改名`}
            title={name + '，编辑声纹名称'} disabled={locked}>
            <span>{name}</span><PencilSimple size={14} aria-hidden="true" />
          </button>}
        {self && <span className="voiceprint-role">本人</span>}
      </div>
      <div className="voiceprint-actions">
        <button type="button" className="voiceprint-more" ref={moreButton} popoverTarget={menuId} aria-haspopup="menu"
          aria-label={`${name}的更多操作`} title="更多操作" disabled={locked}>
          <DotsThree size={18} weight="bold" aria-hidden="true" />
        </button>
        <div id={menuId} ref={menu} popover="auto" className="voiceprint-actions-menu" role="menu" aria-label={`${name}的声纹操作`}
          onToggle={event => {
            if (event.newState === 'open') event.currentTarget.querySelector<HTMLButtonElement>('button:enabled')?.focus({ preventScroll: true });
          }} onKeyDown={event => {
            if (event.key === 'Tab') {
              event.currentTarget.hidePopover();
              return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const items = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:enabled');
            const first = items[0], last = items[items.length - 1];
            const next = event.key === 'Home' ? first : event.key === 'End' || document.activeElement === first ? last : first;
            next?.focus({ preventScroll: true });
          }}>
          <button type="button" role="menuitem" tabIndex={-1} aria-label={`重新录入${name}的声纹`} disabled={busy || locked}
            onClick={() => chooseAction(onEnroll)}>重新录入</button>
          <button type="button" role="menuitem" tabIndex={-1} aria-label={`删除${name}的声纹`} disabled={locked}
            onClick={() => chooseAction(onDelete)}>删除</button>
        </div>
      </div>
    </div>
    {editor.error && <p className="speaker-message" id={errorId} role="alert">名称未保存，请重试。</p>}
  </li>;
}
