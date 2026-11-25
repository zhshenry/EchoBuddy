import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { FeedbackDelivery, FeedbackMode } from '../shared/feedback';
import { FEEDBACK_ORIGIN } from './feedback-service';

// Same read-only release-list probe used by AI HUB. No feedback data is sent to OpenX.
export const COMPANY_PROBE = 'https://openx.huawei.com/openxApi/project/version/release/query/by_project_id?projectId=7938&currentPage=1&pageSize=100';
export const FEEDBACK_MAINTAINER = 'z00545972';
const CACHE_MS = 10 * 60 * 1000;
const topology = () => JSON.stringify(Object.entries(networkInterfaces()).sort(([a], [b]) => a.localeCompare(b))
  .map(([name, addresses]) => [name, addresses?.filter(item => !item.internal).map(item => item.address).sort()]));

export class FeedbackNetwork {
  private mode: FeedbackMode = 'auto';
  private cached?: { company: boolean; online: boolean; checkedAt: string; topology: string };
  private active?: { topology: string; result: Promise<FeedbackDelivery> };
  private readonly path: string;
  constructor(directory: string, private readonly request: typeof fetch = fetch,
    private readonly cliAvailable: () => boolean = () => false, private readonly clock = Date.now,
    private readonly networkKey = topology) {
    mkdirSync(directory, { recursive: true });
    this.path = join(directory, 'feedback-mode.json');
    try {
      const saved = existsSync(this.path) && JSON.parse(readFileSync(this.path, 'utf8'));
      if (['auto', 'online', 'intranet'].includes(saved)) this.mode = saved;
    } catch { /* A damaged preference must not prevent feedback. */ }
  }
  private snapshot(): FeedbackDelivery {
    const company = this.cached?.company ?? false, online = this.cached?.online ?? false;
    return { mode: this.mode, company, online, checkedAt: this.cached?.checkedAt,
      channel: this.mode === 'intranet' || this.mode === 'auto' && company ? 'welink'
        : this.mode === 'online' || this.mode === 'auto' && online ? 'online' : 'unavailable',
      receiver: FEEDBACK_MAINTAINER, cliAvailable: this.cliAvailable() };
  }
  setMode(value: unknown): FeedbackDelivery {
    if (typeof value !== 'string' || !['auto', 'online', 'intranet'].includes(value)) throw new Error('反馈方式无效。');
    writeFileSync(this.path + '.tmp', JSON.stringify(value), { mode: 0o600 });
    renameSync(this.path + '.tmp', this.path);
    this.mode = value as FeedbackMode;
    return this.snapshot();
  }
  read(force = false): Promise<FeedbackDelivery> {
    const key = this.networkKey();
    if (this.active?.topology === key) return this.active.result;
    if (!force && this.cached?.topology === key && this.clock() - Date.parse(this.cached.checkedAt) < CACHE_MS) return Promise.resolve(this.snapshot());
    const result = Promise.all([this.probe(COMPANY_PROBE, true), this.probe(FEEDBACK_ORIGIN + '/health', false)])
      .then(([company, online]) => {
        if (this.active?.result === result) this.cached = { company, online, checkedAt: new Date(this.clock()).toISOString(), topology: key };
        return this.snapshot();
      }).finally(() => { if (this.active?.result === result) this.active = undefined; });
    this.active = { topology: key, result };
    return result;
  }
  private async probe(url: string, company: boolean): Promise<boolean> {
    try {
      const response = await this.request(url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (!response.ok) return false;
      const body = await response.json();
      return company ? String(body?.code) === '0' && Array.isArray(body?.data?.records) : body?.ok === true;
    } catch { return false; }
  }
}
