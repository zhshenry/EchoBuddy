import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { arch, platform, release } from 'node:os';
import { feedbackEvents, feedbackPackageFilename, feedbackSummary, redactFeedback, type FeedbackEvent, type FeedbackImageContent, type FeedbackProduct, type FeedbackRecord } from '../shared/feedback';
import { describeFeedbackImage, feedbackImageBytes, feedbackImageRejection, takeFeedbackImages, type FeedbackImageDraft, type FeedbackImageInput } from '../shared/feedback-images';
import type { FeedbackWelink, WelinkResult } from './feedback-welink';
import { bmpToPng, zipStore } from './feedback-files';

export const FEEDBACK_ORIGIN = 'https://139.224.232.131';
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
let recorder: ((event: FeedbackEvent) => void) | undefined;
export function recordFeedbackEvent(event: FeedbackEvent): void { try { recorder?.(event); } catch { /* Diagnostics must not interrupt the user's operation. */ } }

export class FeedbackService {
  private records: FeedbackRecord[];
  private events: FeedbackEvent[];
  private readonly active = new Map<string, Promise<FeedbackRecord>>();
  private readonly directory: string;
  private readonly historyPath: string;
  private readonly eventsPath: string;
  constructor(directory: string, private readonly product: FeedbackProduct, private readonly version: string,
    private readonly request: typeof fetch = fetch) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true });
    this.historyPath = join(directory, 'feedback-history.json');
    this.eventsPath = join(directory, 'feedback-events.json');
    this.records = this.read<FeedbackRecord>(this.historyPath);
    this.events = this.read<FeedbackEvent>(this.eventsPath).slice(-100);
    recorder = event => this.record(event);
    this.record({ stage: 'application-start', status: 'ready' });
  }
  private read<T>(path: string): T[] {
    if (!existsSync(path)) return [];
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(value)) throw new Error('无法读取本机反馈记录，请保留原文件后重试。');
    return value;
  }
  private write(path: string, value: unknown): void {
    writeFileSync(path + '.tmp', JSON.stringify(value), { mode: 0o600 });
    renameSync(path + '.tmp', path);
  }
  record(event: FeedbackEvent): void {
    const clean: FeedbackEvent = { time: new Date().toISOString() };
    for (const key of ['stage', 'status', 'errorCode', 'messageId', 'operationId', 'toolCallId', 'tool', 'targetId', 'itemId'] as const) {
      if (typeof event[key] === 'string') clean[key] = redactFeedback(event[key]!.slice(0, 160));
    }
    if (Array.isArray(event.selectedItemIds)) clean.selectedItemIds = event.selectedItemIds.slice(0, 20).filter(id => typeof id === 'string').map(id => id.slice(0, 160));
    this.events = [...this.events.slice(-99), clean];
    this.write(this.eventsPath, this.events);
  }
  list(): FeedbackRecord[] { return structuredClone(this.records); }
  prepare(description: unknown, page: unknown, images?: unknown): FeedbackRecord {
    if (typeof description !== 'string' || !description.trim() || description.length > 4000 || typeof page !== 'string' || page.length > 160) throw new Error('请填写 1–4000 字的问题描述。');
    if (this.records.length >= 100) throw new Error('本机已保存 100 条反馈，请先备份并整理反馈历史。');
    const stored = this.incomingImages(images);
    const record: FeedbackRecord = {
      payload: { feedbackId: randomUUID(), product: this.product, appVersion: this.version, description: redactFeedback(description.trim()).slice(0, 4000),
        diagnostics: { platform: platform(), arch: arch(), osVersion: release(), electronVersion: process.versions.electron ?? '', nodeVersion: process.versions.node,
          page: redactFeedback(page), events: feedbackEvents(this.events) } },
      createdAt: new Date().toISOString(), status: 'local',
      ...(stored.length ? { attachments: stored.map(({ name, label, type, data }) => ({ name, label, type, bytes: data.length })) } : {}),
    };
    while (Buffer.byteLength(JSON.stringify(record.payload, null, 2), 'utf8') > 64000 && record.payload.diagnostics.events.length) record.payload.diagnostics.events.shift();
    this.writeImages(record.payload.feedbackId, stored);
    const next = [record, ...this.records];
    this.write(this.historyPath, next);
    this.records = next;
    return structuredClone(record);
  }
  images(id: unknown): FeedbackImageContent[] {
    const record = this.get(id);
    return (record.attachments ?? []).map(item => ({ ...item, data: this.readImage(record.payload.feedbackId, item.name) }));
  }
  private incomingImages(value: unknown): FeedbackImageDraft[] {
    if (value == null) return [];
    if (!Array.isArray(value)) throw new Error('图片附件无效。');
    const inputs: FeedbackImageInput[] = value.map(item => {
      if (!item || typeof item !== 'object') throw new Error('图片附件无效。');
      const record = item as Record<string, unknown>;
      const name = typeof record.name === 'string' ? record.name.slice(0, 180) : '';
      const source = record.source === 'paste' ? 'paste' : record.source === 'file' ? 'file' : undefined;
      if (!source) throw new Error('图片附件无效。');
      const raw = record.data;
      const data = Buffer.isBuffer(raw) ? raw : raw instanceof Uint8Array ? Buffer.from(raw) : undefined;
      if (!data) throw new Error(feedbackImageRejection('type', name || (source === 'paste' ? '粘贴的图片' : '未命名图片')));
      const key = typeof record.key === 'string' ? record.key.slice(0, 80) : undefined;
      if (describeFeedbackImage(data) === 'bmp' && source === 'paste' && data.length <= feedbackImageBytes) {
        try {
          const png = bmpToPng(data);
          if (png.length > feedbackImageBytes) throw new Error(feedbackImageRejection('size', name || '粘贴的图片'));
          return { key, name, source, data: png };
        } catch (error) {
          if (error instanceof Error && error.message.includes('未添加')) throw error;
          throw new Error(feedbackImageRejection('bitmap', name || '粘贴的图片'));
        }
      }
      return { key, name, source, data };
    });
    const accepted = takeFeedbackImages([], inputs);
    if (accepted.error || accepted.images.length !== inputs.length) throw new Error(accepted.error || '图片附件无效。');
    return accepted.images;
  }
  private writeImages(id: string, images: readonly { name: string; data: Uint8Array }[]): void {
    if (!images.length) return;
    const folder = join(this.directory, 'attachments', id);
    mkdirSync(folder, { recursive: true });
    for (const image of images) {
      this.attachmentPath(id, image.name);
      const path = join(folder, image.name);
      writeFileSync(path + '.tmp', image.data, { mode: 0o600 });
      renameSync(path + '.tmp', path);
    }
  }
  private attachmentPath(id: string, name: string): string {
    if (!validId(id) || !/^\d{2}-[\p{L}\p{N}._-]{1,40}\.(png|jpg|webp|gif)$/u.test(name)) throw new Error('图片附件无效。');
    return join(this.directory, 'attachments', id, name);
  }
  private readImage(id: string, name: string): Buffer {
    const path = this.attachmentPath(id, name);
    if (!existsSync(path)) throw new Error(`找不到已保存的图片「${name}」。`);
    return readFileSync(path);
  }
  private get(id: unknown): FeedbackRecord {
    if (!validId(id)) throw new Error('反馈编号无效。');
    const record = this.records.find(item => item.payload.feedbackId === id);
    if (!record) throw new Error('找不到本机反馈记录。');
    return record;
  }
  payload(id: unknown): string { return JSON.stringify(this.get(id).payload, null, 2); }
  summary(id: unknown, receiver: string): string {
    const record = this.get(id);
    return feedbackSummary(record.payload, receiver, record.attachments ?? []);
  }
  /** JSON for a report without images, or a zip of that JSON plus the image files. */
  packageFile(id: string): { name: string; data: Buffer } {
    const record = this.get(id);
    const count = record.attachments?.length ?? 0;
    const jsonName = feedbackPackageFilename(this.product, record.payload.feedbackId, 0);
    const json = Buffer.from(this.payload(id));
    if (!count) return { name: jsonName, data: json };
    const files = [
      { name: jsonName, data: json },
      ...record.attachments!.map(item => ({ name: item.name, data: this.readImage(record.payload.feedbackId, item.name) })),
    ];
    return { name: feedbackPackageFilename(this.product, record.payload.feedbackId, count), data: zipStore(files) };
  }
  savePackage(id: string, directory: string, receiver: string): Promise<FeedbackRecord> {
    return this.exclusive(id, async () => this.package(id, directory, receiver));
  }
  private package(id: string, directory: string, receiver: string): FeedbackRecord {
    const record = structuredClone(this.get(id));
    mkdirSync(directory, { recursive: true });
    const file = record.attachments?.length ? this.packageFile(id) : undefined;
    const path = join(directory, file?.name ?? `${this.product}-feedback-${id}.json`);
    if (file) {
      writeFileSync(path + '.tmp', file.data, { mode: 0o600 });
      renameSync(path + '.tmp', path);
    } else this.write(path, record.payload);
    record.handoff = { ...record.handoff, state: record.handoff?.state ?? 'saved', receiver, packagePath: path };
    return this.save(record);
  }
  handoff(id: string, directory: string, receiver: string, welink: Pick<FeedbackWelink, 'check' | 'send'>): Promise<FeedbackRecord> {
    return this.exclusive(id, async () => {
      let record = this.package(id, directory, receiver);
      if (record.status !== 'local' || record.handoff!.state !== 'saved') return record;
      const error = await welink.check();
      if (error) { record.handoff!.error = error; return this.save(record); }
      record.handoff!.state = 'sending'; record.handoff!.error = undefined;
      this.save(record);
      const result: WelinkResult = await welink.send(receiver, this.summary(id, receiver)).catch(() => ({ state: 'unknown' }));
      record = structuredClone(this.get(id));
      record.handoff!.state = result.state === 'sent' ? 'sent' : result.state === 'failed' ? 'saved' : 'unconfirmed';
      record.handoff!.sentParts = result.sentParts;
      record.handoff!.totalParts = result.totalParts;
      record.handoff!.error = result.error ?? (result.state === 'unknown' ? '摘要是否送达尚未确认。为避免重复，未自动重发，请在 WeLink 核对。' : undefined);
      return this.save(record);
    });
  }
  private save(record: FeedbackRecord): FeedbackRecord {
    const next = this.records.map(item => item.payload.feedbackId === record.payload.feedbackId ? record : item);
    this.write(this.historyPath, next);
    this.records = next;
    return structuredClone(record);
  }
  send(id: string): Promise<FeedbackRecord> { return this.run(id, true); }
  refresh(id: string): Promise<FeedbackRecord> { return this.run(id, false); }
  private run(id: string, send: boolean): Promise<FeedbackRecord> {
    return this.exclusive(id, () => this.deliver(id, send));
  }
  private exclusive(id: string, action: () => Promise<FeedbackRecord>): Promise<FeedbackRecord> {
    const active = this.active.get(id);
    if (active) return active;
    const pending = action().finally(() => this.active.delete(id));
    this.active.set(id, pending);
    return pending;
  }
  private async deliver(id: string, send: boolean): Promise<FeedbackRecord> {
    let record = structuredClone(this.get(id));
    try {
      let response: Response;
      if (record.status !== 'local' || record.handoff) {
        response = await this.request(FEEDBACK_ORIGIN + '/api/feedback/' + id, { signal: AbortSignal.timeout(25000), redirect: 'error' });
        if (response.status === 404 && !send && record.handoff) {
          record.error = '尚未查询到维护人转交的反馈，反馈包仍保存在本机。';
          return this.save(record);
        }
        if (response.status !== 404 || !send) return await this.accept(record, response);
      } else if (!send) return record;
      record.status = 'pending'; record.error = undefined;
      this.save(record);
      // Image bytes are not part of this JSON body. The intake has no attachment contract, and the body stays under the existing limit.
      response = await this.request(FEEDBACK_ORIGIN + '/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record.payload), signal: AbortSignal.timeout(25000), redirect: 'error' });
      return await this.accept(record, response);
    } catch {
      record.error = send ? '暂时无法确认送达。反馈已保存在本机，可重试或保存反馈包。'
        : '暂时无法查询处理状态。已保留上次记录，可稍后查询或将反馈包交给维护人。';
      return this.save(record);
    }
  }
  private async accept(record: FeedbackRecord, response: Response): Promise<FeedbackRecord> {
    if (![200, 202].includes(response.status)) {
      record.error = response.status === 429 ? '提交次数较多，请稍后重试。' : response.status === 409 ? '反馈编号与服务器记录不一致，请保留反馈包交给维护人。' : '暂时无法确认送达，可稍后重试或保存反馈包。';
      return this.save(record);
    }
    const receipt: unknown = await response.json();
    if (!receipt || typeof receipt !== 'object') throw new Error('Invalid receipt');
    const value = receipt as Record<string, unknown>;
    if (value.feedbackId !== record.payload.feedbackId || !['pending', 'submitted', 'failed'].includes(String(value.status))) throw new Error('Invalid receipt');
    record.status = value.status as FeedbackRecord['status'];
    record.error = value.status === 'failed' ? '接收端未能转交，请保存反馈包交给维护人。' : undefined;
    record.progress = ['received', 'in-progress', 'waiting-release', 'resolved', 'closed'].includes(String(value.progress)) ? value.progress as FeedbackRecord['progress'] : undefined;
    record.fixVersion = typeof value.fixVersion === 'string' && /^[0-9A-Za-z.+_-]{1,80}$/.test(value.fixVersion) ? value.fixVersion : undefined;
    return this.save(record);
  }
}
