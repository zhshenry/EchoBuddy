import { useCallback, useEffect, useRef, useState } from 'react';
import { encodeSpeechWave } from '../../shared/speech-audio';
import { SPEECH_SAMPLE_RATE } from '../../shared/speech-contracts';
import { VOICEPRINT_CLIP_SECONDS, VOICEPRINT_SAMPLES } from '../../shared/speaker-contracts';
import { Microphone } from '../audio/microphone';

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
  const [profile, setProfile] = useState<boolean>();
  const [step, setStep] = useState<number | null>(null);
  const [phase, setPhase] = useState<'preparing' | 'recording' | 'processing' | null>(null);
  const [message, setMessage] = useState('');

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
    void desktop.hasVoiceprint().then(saved => { if (mounted) setProfile(saved); }).catch(() => {
      if (mounted) setMessage('无法读取本机声纹，请重新打开设置。');
    });
    return () => { mounted = false; release(); };
  }, [desktop, release]);

  function cancel() {
    release();
    setPhase(null);
    setMessage('');
    setStep(null);
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
        setProfile(true);
        setStep(null);
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
    if (recording.current || busy) return;
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
      const id = await desktop.beginSpeakerCapture('enroll');
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
    try {
      await desktop.deleteVoiceprint();
      setProfile(false);
      setMessage('已删除本机声纹。');
    } catch (error) { setMessage(errorMessage(error)); }
  }

  const enrolling = step !== null;
  const verifying = step === VOICEPRINT_SAMPLES;
  const recordLabel = phase === 'preparing' ? '准备麦克风…' : phase === 'processing' ? '正在处理…' : phase === 'recording' ? '停止录音' : '开始录音';
  return <section className="settings-section" aria-labelledby="voiceprint-heading">
    <div className="row speaker-heading">
      <h2 id="voiceprint-heading">我的声纹</h2>
      {!enrolling && <div className="speaker-actions">
        {profile && <button type="button" disabled={!!phase} onClick={() => void deleteProfile()}>删除声纹</button>}
        <button type="button" className="speaker-record" disabled={profile === undefined || busy || !!phase}
          onClick={() => { setStep(0); setMessage(''); }}>{profile ? '重新录入' : '录入我的声纹'}</button>
      </div>}
    </div>
    <p className="settings-note">{profile ? '已录入，声纹已加密保存在本机。' : '声纹用于识别你的声音，加密保存在本机。'}</p>
    {enrolling && <div className="voiceprint-step">
      <h3 aria-live="polite">{verifying ? '验证声纹' : '录入样本 ' + (step + 1) + ' / ' + VOICEPRINT_SAMPLES}</h3>
      <p className="voiceprint-prompt">{prompts[step]}</p>
      <p className="settings-note">按平常说话的声音读完这句，至少说 3 秒。</p>
      <div className="speaker-actions">
        <button type="button" onClick={cancel}>退出录入</button>
        <button type="button" className="speaker-record"
          disabled={phase === 'preparing' || phase === 'processing' || (busy && !phase)}
          onClick={() => phase === 'recording' && recording.current ? void stop(recording.current) : void start()}>{recordLabel}</button>
      </div>
      {phase === 'recording' && <p className="speaker-message" role="status">正在录音…</p>}
    </div>}
    {message && <p className="speaker-message" role="status">{message}</p>}
  </section>;
}
