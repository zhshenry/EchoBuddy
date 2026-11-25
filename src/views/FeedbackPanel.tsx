import { useEffect, useId, useRef, useState } from 'react';
import { feedbackCapsuleState, feedbackStatus, feedbackSummary, feedbackMessageParts, type FeedbackBridge, type FeedbackCapsuleState, type FeedbackDelivery, type FeedbackMode, type FeedbackRecord } from '../../shared/feedback';

function detectionClock(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function capsuleWord(state: FeedbackCapsuleState): string {
  if (state === 'confirmed') return '已确认';
  if (state === 'checking') return '检测中';
  return '未确认';
}

export function FeedbackNetworkStatus({ checking, error, delivery }: {
  checking: boolean;
  error: string;
  delivery?: Pick<FeedbackDelivery, 'company' | 'online' | 'checkedAt'>;
}) {
  const company = feedbackCapsuleState(checking, !!error, delivery?.company);
  const online = feedbackCapsuleState(checking, !!error, delivery?.online);
  const time = !checking && !error ? detectionClock(delivery?.checkedAt) : '';
  const note = checking ? '检测中…' : error || (time ? `· ${time}` : !delivery ? '尚未检测' : '');
  const summary = checking ? '正在检测公司网络和在线反馈服务'
    : error || (!delivery ? '尚未检测反馈通道' : `公司内网${capsuleWord(company)}，公网${capsuleWord(online)}${time ? `，${time}` : ''}`);
  return <div className="feedback-network" role="status" aria-busy={checking || undefined}>
    <span className="visually-hidden">{summary}</span>
    <div className="feedback-capsules" aria-hidden="true">
      <span className={`feedback-capsule is-${company}`}><span className="feedback-capsule-dot" />公司内网</span>
      <span className={`feedback-capsule is-${online}`}><span className="feedback-capsule-dot" />公网</span>
    </div>
    {note ? <span className="feedback-network-note" aria-hidden="true">{note}</span> : null}
  </div>;
}

export function FeedbackPanel({ api, product, context = 'settings-about' }: { api: FeedbackBridge; product: string; context?: string }) {
  const key = `feedback-draft:${product}`;
  const [description, setDescription] = useState(() => { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } });
  const [preview, setPreview] = useState<FeedbackRecord>();
  const [history, setHistory] = useState<FeedbackRecord[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [delivery, setDelivery] = useState<FeedbackDelivery>();
  const [checking, setChecking] = useState(true);
  const [networkError, setNetworkError] = useState('');
  const networkRevision = useRef(0);
  const gate = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const previewTitle = useRef<HTMLHeadingElement>(null);
  const id = useId();
  useEffect(() => {
    let active = true;
    void api.list().then(value => { if (active) setHistory(value); }, () => { if (active) setError('无法读取本机反馈，请重新打开此页。'); });
    return () => { active = false; };
  }, [api]);
  async function checkDelivery(force = false) {
    const revision = ++networkRevision.current;
    setChecking(true); setNetworkError('');
    try {
      const value = await api.delivery(force);
      if (revision === networkRevision.current) setDelivery(value);
      return value;
    } catch {
      if (revision === networkRevision.current) setNetworkError('无法检测反馈通道，可重新检测或手动选择。');
    } finally { if (revision === networkRevision.current) setChecking(false); }
  }
  useEffect(() => {
    const check = () => { void checkDelivery(); };
    check();
    const timer = window.setInterval(check, 30000);
    window.addEventListener('online', check); window.addEventListener('offline', check); window.addEventListener('focus', check);
    return () => {
      networkRevision.current++; window.clearInterval(timer);
      window.removeEventListener('online', check); window.removeEventListener('offline', check); window.removeEventListener('focus', check);
    };
  }, [api]);
  useEffect(() => { if (preview) previewTitle.current?.focus(); }, [preview?.payload.feedbackId]);
  async function act(action: () => Promise<void>) {
    if (gate.current) return;
    gate.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : '操作未完成，请重试。'); }
    finally { gate.current = false; setBusy(false); }
  }
  async function update(record: FeedbackRecord) {
    setPreview(record); setHistory(await api.list());
    if (record.status === 'submitted' || (record.status === 'pending' && !record.error) || record.handoff?.state === 'sent') {
      setDescription(''); localStorage.removeItem(key);
      setNotice(record.status === 'submitted' ? '反馈已提交，可在下方查看处理状态。' : record.handoff?.state === 'sent'
        ? '摘要已发给维护人，请继续把下载文件夹中的完整反馈包发给对方。' : '反馈已接收，正在转交。');
    }
  }
  const pending = !!preview && (preview.status === 'local' || preview.status === 'pending');
  const channel = preview && preview.status !== 'local' ? 'online' : delivery?.channel;
  const handedOff = !!preview?.handoff && preview.handoff.state !== 'saved';
  const welink = channel === 'welink';
  const routing = <div className="feedback-routing">
      <div className="feedback-route-controls">
        <label htmlFor={`${id}-mode`}>反馈方式</label>
        <select id={`${id}-mode`} value={delivery?.mode ?? 'auto'} disabled={busy || !!preview && preview.status !== 'local'} onChange={event => {
          const mode = event.target.value as FeedbackMode;
          networkRevision.current++; setChecking(false); setNetworkError('');
          void act(async () => { setDelivery(await api.setMode(mode)); });
        }}>
          <option value="auto">自动选择</option><option value="online">在线提交</option><option value="intranet">内网转交</option>
        </select>
        <button type="button" disabled={checking || busy} onClick={() => void checkDelivery(true)}>{checking ? '检测中…' : '重新检测'}</button>
      </div>
      <FeedbackNetworkStatus checking={checking} error={networkError} delivery={delivery} />
      <p className="feedback-muted">{channel === 'online' ? '发送位置：在线反馈服务。提交后可查询处理状态。'
        : welink ? `发送位置：WeLink 维护人 ${delivery?.receiver}。发送摘要后，还需将完整反馈包交给维护人。`
        : '反馈会保存在本机。你可以手动选择反馈方式，或保存反馈包。'}</p>
      {welink && !delivery?.cliAvailable && <p className="feedback-muted">未找到 WeLink 命令行工具，可在预览后复制摘要并打开 WeLink。</p>}
    </div>;
  return <section className="settings-section feedback-panel" aria-label="问题反馈">
    <header className="row feedback-heading">
      <h2 id={`${id}-title`} ref={previewTitle} tabIndex={preview ? -1 : undefined}>
        {preview ? '核对反馈内容' : <label htmlFor={`${id}-description`}>问题描述</label>}
      </h2>
      {preview ? <span className="feedback-status" role="status">{feedbackStatus(preview)}</span>
        : <span className="feedback-limit">{description.length} / 4000</span>}
    </header>
    {!preview ? <form noValidate onSubmit={event => { event.preventDefault(); void act(async () => {
      if (!description.trim()) { setError('请填写问题描述。'); input.current?.focus(); return; }
      setPreview(await api.prepare(description, context)); setHistory(await api.list());
    }); }}>
      <textarea ref={input} id={`${id}-description`} maxLength={4000} rows={4} value={description} disabled={busy} style={{ resize: 'none' }}
        placeholder="你做了什么？期望发生什么？实际出现了什么？"
        aria-describedby={`${id}-help`} onChange={event => { const value = event.target.value; setDescription(value); try { localStorage.setItem(key, value); } catch { setError('无法保存本机草稿，请先复制问题描述。'); } }} />
      {routing}
      <div className="feedback-compose-footer">
        <p id={`${id}-help`} className="feedback-muted">自动附带版本、系统和近期操作诊断，不自动读取聊天、记忆、录音或文件。</p>
        <div className="feedback-actions"><button type="submit" className="feedback-primary" disabled={busy || !description.trim()}>{busy ? '准备中…' : '预览反馈'}</button></div>
      </div>
    </form> : <div className="feedback-preview">
      {routing}
      <p className="feedback-description">{preview.payload.description}</p>
      <dl><div><dt>产品版本</dt><dd>{product} · {preview.payload.appVersion}</dd></div><div><dt>反馈编号</dt><dd>{preview.payload.feedbackId}</dd></div></dl>
      {welink && <details className="feedback-diagnostics"><summary>查看将发给维护人的摘要</summary>
        <p className="feedback-muted">含最近异常与关键操作，最多分两条发送。以下内容已脱敏。</p>
        {feedbackMessageParts(feedbackSummary(preview.payload, delivery!.receiver)).map((part, index) => <pre key={index} className="feedback-summary">{part}</pre>)}
      </details>}
      <details className="feedback-diagnostics"><summary>查看将附带的诊断</summary><pre>{JSON.stringify(preview.payload.diagnostics, null, 2)}</pre></details>
      <p className="feedback-muted">内容仅供维护人员查看。请检查描述和诊断中是否还包含不希望发送的信息。</p>
      {preview.error && <p role="alert" className="feedback-error">{preview.error}</p>}
      {preview.handoff && <p className="feedback-muted">完整反馈包：{preview.handoff.packagePath}</p>}
      {preview.handoff?.error && <p role="alert" className="feedback-error">{preview.handoff.error}</p>}
      <div className="feedback-actions">
        <button type="button" disabled={busy} onClick={() => { setPreview(undefined); requestAnimationFrame(() => input.current?.focus()); }}>返回填写</button>
        <button type="button" disabled={busy} onClick={() => void act(async () => { await api.copy(preview.payload.feedbackId); setNotice('已复制反馈内容，尚未发送。'); })}>复制反馈</button>
        <button type="button" disabled={busy} onClick={() => void act(async () => { if (await api.export(preview.payload.feedbackId)) setNotice('反馈包已保存，尚未因此发送。内网可将反馈包交给维护人。'); })}>保存反馈包</button>
        {(welink || preview.handoff) && <button type="button" disabled={busy} onClick={() => void act(async () => {
          const result = await api.copyWelink(preview.payload.feedbackId); await update(result.record);
          setNotice(result.opened ? `摘要已复制，请在 WeLink 中发给 ${delivery?.receiver ?? preview.handoff?.receiver}，并附上下载文件夹中的反馈包。`
            : `摘要已复制。请手动打开 WeLink 发给 ${delivery?.receiver ?? preview.handoff?.receiver}，并附上反馈包。`);
        })}>复制摘要并打开 WeLink</button>}
        <button type="button" className="feedback-primary" disabled={busy || checking || preview.status === 'failed' || preview.status === 'local' && !handedOff && (!channel || channel === 'unavailable' || welink && !delivery?.cliAvailable)} onClick={() => void act(async () => {
          try { await update(await (pending && !handedOff ? api.send(preview.payload.feedbackId, channel!) : api.refresh(preview.payload.feedbackId))); }
          finally { await checkDelivery(); }
        })}>
          {busy ? '处理中…' : handedOff || !pending ? '查询处理状态' : welink ? '确认发送摘要' : preview.status === 'local' ? '确认发送' : '重试发送 / 查询'}
        </button>
      </div>
    </div>}
    {error && <p role="alert" className="feedback-error">{error}</p>}
    {notice && <p role="status" className="feedback-notice">{notice}</p>}
    <details className="feedback-history"><summary>我的反馈{history ? `（${history.length}）` : ''}</summary>
      {history === undefined ? <p role="status">正在读取本机记录…</p> : !history.length ? <p className="feedback-muted">还没有反馈记录。</p> :
        <ul>{history.map(record => <li key={record.payload.feedbackId}><button type="button" disabled={busy} onClick={() => { setError(''); setNotice(''); setPreview(record); }}>
          <span>{record.payload.description.split('\n')[0]}</span><small>{new Date(record.createdAt).toLocaleString('zh-CN')} · {feedbackStatus(record)}</small>
        </button></li>)}</ul>}
    </details>
  </section>;
}
