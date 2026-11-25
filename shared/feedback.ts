export type FeedbackProduct = 'onosan_workbench' | 'cmo_workbench' | 'echobuddy';
export type FeedbackMode = 'auto' | 'online' | 'intranet';
export type FeedbackChannel = 'online' | 'welink' | 'unavailable';
export type FeedbackDelivery = {
  mode: FeedbackMode;
  channel: FeedbackChannel;
  company: boolean;
  online: boolean;
  checkedAt?: string;
  receiver: string;
  cliAvailable: boolean;
};
export type FeedbackEvent = { time?: string; stage?: string; status?: string; errorCode?: string; messageId?: string; operationId?: string; toolCallId?: string; tool?: string; selectedItemIds?: string[]; targetId?: string; itemId?: string };
export interface FeedbackPayload {
  feedbackId: string;
  product: FeedbackProduct;
  appVersion: string;
  description: string;
  diagnostics: { platform: string; arch: string; osVersion: string; electronVersion: string; nodeVersion: string; page: string; events: FeedbackEvent[] };
}
export type FeedbackRecord = {
  payload: FeedbackPayload;
  createdAt: string;
  status: 'local' | 'pending' | 'submitted' | 'failed';
  progress?: 'received' | 'in-progress' | 'waiting-release' | 'resolved' | 'closed';
  fixVersion?: string;
  error?: string;
  handoff?: { state: 'saved' | 'sending' | 'sent' | 'unconfirmed'; receiver: string; packagePath: string; error?: string };
};
export interface FeedbackBridge {
  prepare(description: string, page: string): Promise<FeedbackRecord>;
  list(): Promise<FeedbackRecord[]>;
  delivery(force?: boolean): Promise<FeedbackDelivery>;
  setMode(mode: FeedbackMode): Promise<FeedbackDelivery>;
  send(id: string, channel: FeedbackChannel): Promise<FeedbackRecord>;
  refresh(id: string): Promise<FeedbackRecord>;
  export(id: string): Promise<boolean>;
  copy(id: string): Promise<void>;
  copyWelink(id: string): Promise<{ record: FeedbackRecord; opened: boolean }>;
}
export function feedbackStatus(record: FeedbackRecord): string {
  if (record.status === 'local' && record.handoff) {
    if (record.handoff.state === 'sent') return '摘要已发送，反馈包待转交';
    if (record.handoff.state === 'sending' || record.handoff.state === 'unconfirmed') return '摘要送达未确认，反馈包已保留';
    return '反馈包已保存，待转交';
  }
  if (record.status === 'local') return '本机保存，待发送';
  if (record.status === 'pending') return record.error ? '等待重试' : '已接收，等待转交';
  if (record.status === 'failed') return '转交失败';
  if (record.progress === 'resolved' && record.fixVersion) return `已解决 · ${record.fixVersion}`;
  if (record.progress === 'in-progress') return '处理中';
  if (record.progress === 'waiting-release') return '待发布';
  if (record.progress === 'closed') return '已结束处理';
  return '已提交，待处理';
}
export function redactFeedback(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key removed]')
    .replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|LTAI[A-Za-z0-9]{12,})\b/g, '[credential removed]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[token removed]')
    .replace(/\b(authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/gi, '$1: [credential removed]')
    .replace(/(["']?(?:password|passwd|token|secret|api[_-]?key|access[_-]?key(?:[_-]?(?:id|secret))?)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, '$1[credential removed]')
    .replace(/\b[A-Z]:\\Users\\[^\\\s"'<>]+/gi, 'C:\\Users\\[user]')
    .replace(/\/(?:home|Users)\/[^/\s"'<>]+/g, '/home/[user]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email removed]')
    .replaceAll('@', '@\u200b');
}
export function feedbackEvents(events: FeedbackEvent[]): FeedbackEvent[] {
  const aliases = new Map<string, string>();
  const alias = (id: string) => { if (!aliases.has(id)) aliases.set(id, `item-${aliases.size + 1}`); return aliases.get(id)!; };
  return events.slice(-100).map(event => {
    const result: FeedbackEvent = {};
    for (const key of ['time', 'stage', 'status', 'errorCode', 'messageId', 'operationId', 'toolCallId', 'tool'] as const) {
      if (typeof event[key] === 'string') result[key] = redactFeedback(event[key]!.slice(0, 160));
    }
    if (Array.isArray(event.selectedItemIds)) result.selectedItemIds = event.selectedItemIds.slice(0, 20).filter(id => typeof id === 'string' && !!id).map(alias);
    for (const key of ['targetId', 'itemId'] as const) if (typeof event[key] === 'string' && event[key]) result[key] = alias(event[key]!);
    return result;
  });
}
export function feedbackSummary(payload: FeedbackPayload, receiver: string): string {
  const text = `EchoBuddy 问题反馈\n编号：${payload.feedbackId}\n版本：${payload.appVersion}\n系统：${payload.diagnostics.platform} ${payload.diagnostics.osVersion} ${payload.diagnostics.arch}\n\n${payload.description}`;
  const suffix = `\n\n完整诊断已保存为 ${payload.product}-feedback-${payload.feedbackId}.json，请将下载文件夹中的反馈包发给维护人 ${receiver}。`;
  const limit = 1450 - suffix.length;
  return (text.length > limit ? text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '') + '…' : text) + suffix;
}
