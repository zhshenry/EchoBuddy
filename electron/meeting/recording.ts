import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import {
  initialMeetingCapture, MEETING_SOURCE_NAMES, MEETING_SOURCES,
  type MeetingCaptureState, type MeetingRecord, type MeetingSource,
} from '../../shared/meeting-contracts';
import type { SpeechLanguage } from '../../shared/speech-contracts';
import type { MeetingStore } from './store';

type CaptureProcess = ChildProcessByStdio<Writable, Readable, null>;
const sourceNames = (sources: Iterable<MeetingSource>) => [...sources].map(source => MEETING_SOURCE_NAMES[source]).join('、');

export class MeetingRecording {
  private state = initialMeetingCapture;
  private child?: CaptureProcess;
  private watchdog?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    private readonly executable: string,
    private readonly store: MeetingStore,
    private readonly loadLibrary: () => Promise<void>,
    private readonly publish: (state: MeetingCaptureState) => void,
    private readonly saved: () => void,
  ) {}

  snapshot(): MeetingCaptureState { return this.state; }
  get active(): boolean { return this.state.phase !== 'idle'; }

  start(sources: MeetingSource[], language: SpeechLanguage): void {
    if (this.active) return;
    this.set({ ...initialMeetingCapture, phase: 'preparing', sources });
    this.running = this.capture(sources, language);
  }

  stop(): void {
    if (!this.active || this.state.phase === 'saving') return;
    this.set({ phase: 'saving' });
    this.child?.stdin.end();
    this.armWatchdog();
  }

  async finishOnQuit(): Promise<void> {
    this.stop();
    await this.running;
  }

  clearNotice(): void {
    this.set({ latestId: null, message: '' });
  }

  private set(change: Partial<MeetingCaptureState>): void {
    this.state = { ...this.state, ...change };
    this.publish(this.state);
  }

  private armWatchdog(): void {
    clearTimeout(this.watchdog);
    const child = this.child;
    if (child) this.watchdog = setTimeout(() => child.kill(), 10000);
  }

  private async capture(sources: MeetingSource[], language: SpeechLanguage): Promise<void> {
    try {
      await this.loadLibrary();
      if (this.state.phase === 'saving') {
        this.set(initialMeetingCapture);
        return;
      }
      const record = await this.store.begin(sources, language);
      if (this.state.phase !== 'preparing') {
        await this.store.finish(record, '');
        this.set(initialMeetingCapture);
        return;
      }
      await this.captureTo(record);
    } catch (error) {
      console.error('EchoBuddy meeting capture failed', error);
      this.set({ ...initialMeetingCapture, message: '无法保存会议录音，请检查本机录音文件夹和可用空间。' });
    } finally {
      clearTimeout(this.watchdog);
      this.child = undefined;
    }
  }

  private async captureTo(record: MeetingRecord): Promise<void> {
    const { id, sources } = record;
    const child = this.child = spawn(this.executable, [this.store.directory(id), sources.length === 2 ? 'both' : sources[0]], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    child.stdin.on('error', () => {});
    this.armWatchdog();
    const disconnected = new Set<MeetingSource>();
    let ready = false, problem = '', pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      pending += data;
      let end: number;
      while ((end = pending.indexOf('\n')) !== -1) {
        const [event, value] = pending.slice(0, end).trim().split(' ');
        pending = pending.slice(end + 1);
        const source = MEETING_SOURCES.find(item => item === value);
        if (event === 'ready') {
          ready = true;
          if (this.state.phase === 'preparing') {
            clearTimeout(this.watchdog);
            this.set({ phase: 'recording', startedAt: Date.now() });
          }
        } else if (event === 'warning' && source) {
          disconnected.add(source);
          this.set({ message: sourceNames(disconnected) + '已中断。' });
        } else if (event === 'error') {
          problem = source
            ? '无法启动' + MEETING_SOURCE_NAMES[source] + '，请检查设备或重新选择录音来源。'
            : value === 'disk' ? '写入录音文件失败，请检查本机可用空间。' : '无法启动 Windows 音频设备，请检查录音来源。';
        }
      }
    });
    const exit = await new Promise<number | null>(resolve => {
      child.once('error', error => {
        console.error('EchoBuddy recording helper failed', error);
        problem = '无法启动本机录音组件，请修复安装后重试。';
      });
      child.once('close', resolve);
    });
    clearTimeout(this.watchdog);
    this.set({ phase: 'saving' });
    const warning = [
      disconnected.size ? sourceNames(disconnected) + '中断，音频保留了对应的时间缺口。' : '',
      exit !== 0 && ready ? (problem || '录音意外中断。') : '',
    ].filter(Boolean).join('');
    const result = await this.store.finish(record, warning);
    if (result.durationMs) {
      this.set({ ...initialMeetingCapture, latestId: id, message: '录音已保存' });
      this.saved();
    } else this.set({
      ...initialMeetingCapture,
      message: problem || (exit === 0 ? (ready ? '这次没有录到音频。' : '') : '无法打开' + sourceNames(sources) + '，请检查设备后重试。'),
    });
  }
}
