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
export type FeedbackImageType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
export type FeedbackAttachment = { name: string; label: string; type: FeedbackImageType; bytes: number };
export type FeedbackImageUpload = { key?: string; name: string; source: 'file' | 'paste'; data: Uint8Array };
export type FeedbackImageContent = FeedbackAttachment & { data: Uint8Array };
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
  attachments?: FeedbackAttachment[];
  handoff?: { state: 'saved' | 'sending' | 'sent' | 'unconfirmed'; receiver: string; packagePath: string; error?: string; sentParts?: number; totalParts?: number };
};
export function feedbackPackageFilename(product: string, feedbackId: string, imageCount: number): string {
  return `${product}-feedback-${feedbackId}.${imageCount ? 'zip' : 'json'}`;
}
export interface FeedbackBridge {
  prepare(description: string, page: string, images?: FeedbackImageUpload[]): Promise<FeedbackRecord>;
  list(): Promise<FeedbackRecord[]>;
  images(id: string): Promise<FeedbackImageContent[]>;
  delivery(force?: boolean): Promise<FeedbackDelivery>;
  setMode(mode: FeedbackMode): Promise<FeedbackDelivery>;
  send(id: string, channel: FeedbackChannel): Promise<FeedbackRecord>;
  refresh(id: string): Promise<FeedbackRecord>;
  export(id: string): Promise<boolean>;
  copy(id: string): Promise<void>;
  copyWelink(id: string): Promise<{ record: FeedbackRecord; opened: boolean }>;
}
export type FeedbackCapsuleState = 'checking' | 'confirmed' | 'unconfirmed';

/** Visible reachability for one probe. An in-progress check hides the previous conclusion. */
export function feedbackCapsuleState(checking: boolean, failed: boolean, confirmed: boolean | undefined): FeedbackCapsuleState {
  if (checking) return 'checking';
  if (failed || typeof confirmed !== 'boolean') return 'unconfirmed';
  return confirmed ? 'confirmed' : 'unconfirmed';
}

export function feedbackStatus(record: FeedbackRecord): string {
  if (record.status === 'local' && record.handoff) {
    if (record.handoff.state === 'sent') return '摘要已发送，反馈包待转交';
    if (record.handoff.sentParts && record.handoff.totalParts) return `已确认发送 ${record.handoff.sentParts}/${record.handoff.totalParts} 条摘要，请核对`;
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
const feedbackStages: Record<string, string> = {
  'dictation:start': '开始听写', 'dictation:stop': '停止听写', 'dictation:complete': '听写结束',
  'dictation:insert-pending': '补写文字', 'dictation:copy': '复制转写',
  'input:capture': '检测输入位置', 'input:insert': '自动写入', 'input:current': '写入当前光标',
  'speech:transcribe': '语音识别', 'speech:meeting': '会议转写', 'speech:embedding': '提取声纹', 'speech:speakers': '区分说话人',
  'meeting:stop': '保存会议', 'meeting:retry': '重新转写会议', 'meeting:delete': '删除会议', 'meeting:rename': '会议改名',
  'renderer-process': '设置页面进程', 'child-process': '后台进程',
};
const feedbackResults: Record<string, string> = {
  captured: '找到输入位置', 'paste-on-stop': '停录后粘贴', written: '已写入', moved: '输入位置变化',
  partial: '可能部分写入', 'paste-unconfirmed': '粘贴结果未确认', unavailable: '目标不可用',
  completed: '完成', failed: '失败', retained: '转写已保留', empty: '未识别到语音',
  sentence: '整句写入', streaming: '流式输入', requested: '已请求',
};
function feedbackClip(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '') + '…' : text;
}
export function feedbackSummary(payload: FeedbackPayload, receiver: string, attachments: readonly { name: string }[] = []): string {
  const head = `EchoBuddy 问题反馈\n编号：${payload.feedbackId}\n版本：${payload.appVersion}\n系统：${payload.diagnostics.platform} ${payload.diagnostics.osVersion} ${payload.diagnostics.arch}`;
  const packageName = feedbackPackageFilename(payload.product, payload.feedbackId, attachments.length);
  const listed = attachments.map(item => item.name.replace(/[\r\n\t]+/g, ' ')).join('、');
  const names = listed.length > 180 ? listed.slice(0, 179).replace(/[\uD800-\uDBFF]$/u, '') + '…' : listed;
  const suffix = attachments.length
    ? `\n\n图片附件 ${attachments.length} 张：${names}。完整图片只在反馈包内。\n\n完整诊断和图片已保存为 ${packageName}，请将下载文件夹中的反馈包发给维护人 ${receiver}。`
    : `\n\n完整诊断已保存为 ${packageName}，请将下载文件夹中的反馈包发给维护人 ${receiver}。`;
  const seen = new Set<string>(), errors: string[] = [], actions: string[] = [];
  // Only use the already previewed, sanitized event snapshot; never reread live logs here.
  for (const event of [...payload.diagnostics.events].reverse()) {
    const stage = event.stage ?? '', status = event.status ?? '', code = event.errorCode ?? '';
    const failure = /fail|error|timeout|unavailable|partial|unconfirmed|moved|crash|oom/i.test(status) || !!code && code !== '0';
    if (!failure && !feedbackStages[stage]) continue;
    if (!failure && (stage === 'child-process' || stage === 'renderer-process')) continue;
    const signature = [stage, status, code].join('\n');
    if (seen.has(signature)) continue;
    seen.add(signature);
    const clock = event.time?.match(/T(\d{2}:\d{2}:\d{2})/)?.[1];
    const line = feedbackClip([clock && `${clock} UTC`, feedbackStages[stage] ?? stage, feedbackResults[status] ?? status, code].filter(Boolean).join(' · ').replace(/[\r\n\t]+/g, ' '), 220);
    const list = failure ? errors : actions;
    if (list.length < (failure ? 6 : 4)) list.push(line);
  }
  const diagnostics = (errors.length ? '\n\n最近异常（新的在前）\n' + errors.join('\n') : '')
    + (actions.length ? '\n\n关键操作（新的在前）\n' + actions.join('\n') : '');
  // Reserve space for the user's description, then prefer recent failures over routine actions.
  const description = feedbackClip(payload.description, Math.max(200, 2800 - head.length - suffix.length - Math.min(diagnostics.length, 900) - 2));
  const text = head + '\n\n' + description;
  const room = Math.max(0, 2800 - text.length - suffix.length);
  return text + (room > 40 ? feedbackClip(diagnostics, room) : '') + suffix;
}
export function feedbackMessageParts(summary: string): string[] {
  if (summary.length <= 1450) return [summary];
  const text = feedbackClip(summary, 2800);
  let cut = text.lastIndexOf('\n', 1440);
  if (cut < text.length - 1440) cut = 1440;
  if (/[\uD800-\uDBFF]/.test(text[cut - 1])) cut--;
  return [`（1/2）${text.slice(0, cut)}`, `（2/2）${text.slice(cut)}`];
}
