import type { AppUpdater } from 'electron-updater';
import type { UpdateStatus } from '../shared/desktop';

export const releasesUrl = 'https://github.com/zhshenry/EchoBuddy/releases';
type UpdateDriver = Pick<AppUpdater, 'on' | 'checkForUpdates' | 'quitAndInstall' | 'autoDownload' | 'autoInstallOnAppQuit'>;

// Mirrors the OnoSan updater. The main process owns both the download status and the install guard.
export class AppUpdates {
  private state: UpdateStatus;
  private installing = false;

  constructor(
    current: string, private readonly driver: UpdateDriver | null,
    private readonly publish: (state: UpdateStatus) => void,
    private readonly blocksInstall: () => boolean,
  ) {
    this.state = { current, enabled: !!driver, phase: 'idle', version: '', progress: 0,
      message: driver ? '启动后自动检查，每 4 小时检查一次。' : '' };
    if (!driver) return;
    driver.autoDownload = true;
    driver.autoInstallOnAppQuit = false;
    driver.on('checking-for-update', () => this.set({ phase: 'checking', message: '正在检查更新…' }));
    driver.on('update-not-available', () => this.set({ phase: 'latest', version: '', progress: 0, message: '当前已是最新版本。' }));
    driver.on('update-available', info => this.set({ phase: 'downloading', version: info.version, progress: 0, message: `v${info.version} 正在后台下载` }));
    driver.on('download-progress', progress => this.set({ progress: Math.max(0, Math.min(100, Math.floor(progress.percent))) }));
    driver.on('update-downloaded', info => this.set({ phase: 'ready', version: info.version, progress: 100, message: `v${info.version} 已下载` }));
    driver.on('error', error => this.fail(error));
  }

  snapshot(): UpdateStatus { return this.state; }
  isInstalling(): boolean { return this.installing; }

  async check(): Promise<void> {
    if (!this.driver || this.installing || ['checking', 'downloading', 'ready'].includes(this.state.phase)) return;
    this.set({ phase: 'checking', progress: 0, message: '正在检查更新…' });
    try {
      const result = await this.driver.checkForUpdates();
      if (!result && this.state.phase === 'checking') this.set({ phase: 'idle', message: '暂时无法检查更新。' });
    }
    catch (error) { this.fail(error); }
  }

  install(): boolean {
    if (!this.driver || this.installing || this.state.phase !== 'ready' || this.blocksInstall()) return false;
    this.installing = true;
    try {
      this.driver.quitAndInstall(true, true);
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  private fail(error: unknown): void {
    this.installing = false;
    const detail = error instanceof Error ? error.message : String(error);
    const message = /404|ERR_UPDATER_LATEST_VERSION_NOT_FOUND|Cannot find latest|No published/i.test(detail)
      ? '发布页暂时没有可用版本。'
      : '无法检查或安装更新，请稍后重试。';
    this.set({ phase: 'error', progress: 0, message });
  }

  private set(changes: Partial<UpdateStatus>): void {
    this.state = { ...this.state, ...changes };
    this.publish(this.state);
  }
}
