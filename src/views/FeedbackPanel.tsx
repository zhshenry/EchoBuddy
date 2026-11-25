import { useEffect, useId, useRef, useState, type ClipboardEvent } from 'react';
import { feedbackCapsuleState, feedbackStatus, feedbackSummary, feedbackMessageParts, type FeedbackAttachment, type FeedbackBridge, type FeedbackCapsuleState, type FeedbackChannel, type FeedbackDelivery, type FeedbackImageUpload, type FeedbackMode, type FeedbackRecord } from '../../shared/feedback';
import { describeFeedbackImage, feedbackClipboardImages, feedbackImageBytes, feedbackImageRejection, feedbackImageTransportNote, removeFeedbackImage, takeFeedbackImages, type FeedbackImageDraft } from '../../shared/feedback-images';

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

export type FeedbackThumb = { key: string; name: string; label: string; url?: string };

export function FeedbackAttachmentSection({ images, error = '', notice = '', canEdit, disabled = false, onAdd, onRemove }: {
  images: readonly FeedbackThumb[];
  error?: string;
  notice?: string;
  canEdit: boolean;
  disabled?: boolean;
  onAdd?: () => void;
  onRemove?: (key: string) => void;
}) {
  return <div className="feedback-attachments">
    <div className="feedback-attachment-head">
      <span>图片附件（可选，最多 5 张）</span>
      {canEdit && <button type="button" disabled={disabled} onClick={onAdd}>添加图片</button>}
    </div>
    {!!images.length && <div className="feedback-thumbs">
      {images.map(image => <figure className="feedback-thumb" key={image.key}>
        {image.url ? <img src={image.url} alt="" /> : <span className="feedback-thumb-pending" role="img" aria-label={image.label} />}
        <figcaption title={`${image.label} · ${image.name}`}>{image.label}</figcaption>
        {canEdit && <button type="button" className="feedback-thumb-remove" aria-label={`移除${image.label}`} onClick={() => onRemove?.(image.key)}>×</button>}
      </figure>)}
    </div>}
    {!!images.length && <p className="feedback-muted feedback-attachment-files">图片 {images.length} 张：{images.map(image => image.name).join('、')}</p>}
    {canEdit && <p className="feedback-muted">可点击添加，或在此页粘贴图片。图片由你选择后才会附带。</p>}
    {error && <p role="alert" className="feedback-error">{error}</p>}
    {notice && <p className="feedback-image-note" role="status">{notice}</p>}
  </div>;
}

function imageBlob(data: Uint8Array, type = ''): Blob {
  const copy = new ArrayBuffer(data.byteLength);
  new Uint8Array(copy).set(data);
  return new Blob([copy], type ? { type } : undefined);
}

function imageUrl(data: Uint8Array, type: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('无法读取图片。'));
    reader.readAsDataURL(imageBlob(data, type));
  });
}

async function bitmapToPng(data: Uint8Array): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(imageBlob(data));
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context || !bitmap.width || !bitmap.height) throw new Error('bitmap');
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('bitmap');
    return new Uint8Array(await blob.arrayBuffer());
  } finally { bitmap.close(); }
}

function thumbsFrom(images: readonly { key: string; name: string; label: string; url?: string }[]): FeedbackThumb[] {
  return images.map(image => ({ key: image.key, name: image.name, label: image.label, url: image.url }));
}

function savedThumbs(attachments: readonly FeedbackAttachment[], opened?: { id: string; images: FeedbackThumb[] }, id?: string): FeedbackThumb[] {
  if (opened && opened.id === id) return opened.images;
  return attachments.map(item => ({ key: item.name, name: item.name, label: item.label || item.name }));
}

export function FeedbackPanel({ api, product, context = 'settings-about' }: { api: FeedbackBridge; product: string; context?: string }) {
  const key = `feedback-draft:${product}`;
  const [description, setDescription] = useState(() => { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } });
  const [drafts, setDrafts] = useState<FeedbackImageDraft[]>([]);
  const [preview, setPreview] = useState<FeedbackRecord>();
  const [opened, setOpened] = useState<{ id: string; images: FeedbackThumb[] }>();
  const [history, setHistory] = useState<FeedbackRecord[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [imageError, setImageError] = useState('');
  const [imageLoadError, setImageLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [delivery, setDelivery] = useState<FeedbackDelivery>();
  const [checking, setChecking] = useState(true);
  const [networkError, setNetworkError] = useState('');
  const networkRevision = useRef(0);
  const gate = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const previewTitle = useRef<HTMLHeadingElement>(null);
  const draftsRef = useRef(drafts);
  const adding = useRef(Promise.resolve());
  const alive = useRef(true);
  const id = useId();
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => {
    let active = true;
    void api.list().then(value => { if (active) setHistory(value); }, () => { if (active) setError('无法读取本机反馈，请重新打开此页。'); });
    return () => { active = false; };
  }, [api]);
  useEffect(() => {
    const feedbackId = preview?.payload.feedbackId;
    const attachments = preview?.attachments ?? [];
    if (!feedbackId || !attachments.length) return;
    let active = true;
    setImageLoadError('');
    void api.images(feedbackId).then(async files => {
      if (!active) return;
      const images = await Promise.all(attachments.map(async item => {
        const file = files.find(entry => entry.name === item.name);
        if (!file) return { key: item.name, name: item.name, label: item.label || item.name };
        return { key: item.name, name: item.name, label: item.label || item.name, url: await imageUrl(file.data, file.type) };
      }));
      if (!active) return;
      setOpened({ id: feedbackId, images });
      if (images.some(item => !item.url)) setImageLoadError('无法读取已保存的图片。');
    }, () => { if (active) setImageLoadError('无法读取已保存的图片。'); });
    return () => { active = false; };
  }, [api, preview?.payload.feedbackId, preview?.attachments]);
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
  function remember(images: FeedbackImageDraft[]) {
    draftsRef.current = images;
    setDrafts(images);
  }
  async function addFilesNow(list: File[], source: 'file' | 'paste') {
    const errors: string[] = [];
    const incoming: FeedbackImageUpload[] = [];
    for (const file of list) {
      const shown = file.name || (source === 'paste' ? '粘贴的图片' : '未命名图片');
      if (file.size > feedbackImageBytes) { errors.push(feedbackImageRejection('size', shown)); continue; }
      let data: Uint8Array;
      try { data = new Uint8Array(await file.arrayBuffer()); }
      catch { errors.push(feedbackImageRejection('type', shown)); continue; }
      if (source === 'paste' && describeFeedbackImage(data) === 'bmp') {
        try { data = await bitmapToPng(data); }
        catch { errors.push(feedbackImageRejection('bitmap', shown)); continue; }
      }
      incoming.push({ key: crypto.randomUUID(), name: file.name, source, data });
    }
    if (!alive.current) return;
    const result = takeFeedbackImages(draftsRef.current, incoming);
    const next = await Promise.all(result.images.map(async item => item.url ? item : { ...item, url: await imageUrl(item.data, item.type) }));
    remember(next);
    setImageError(errors.concat(result.error).filter(Boolean).join(''));
  }
  function addFiles(list: File[], source: 'file' | 'paste') {
    const run = adding.current.then(() => addFilesNow(list, source));
    adding.current = run.then(() => undefined, () => undefined);
    return run;
  }
  function removeImage(imageKey: string) {
    remember(removeFeedbackImage(draftsRef.current, imageKey));
  }
  async function onPaste(event: ClipboardEvent<HTMLFormElement>) {
    if (preview || busy) return;
    const files = [...event.clipboardData.files];
    const itemFiles = [...event.clipboardData.items].flatMap(item => item.kind === 'file' ? [item.getAsFile()].filter((file): file is File => !!file) : []);
    const images = feedbackClipboardImages(files, itemFiles);
    if (!images) return;
    event.preventDefault();
    await addFiles(images, 'paste');
  }
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
      remember([]);
      setNotice(record.status === 'submitted' ? '反馈已提交，可在下方查看处理状态。' : record.handoff?.state === 'sent'
        ? '摘要已发给维护人，请继续把下载文件夹中的完整反馈包发给对方。' : '反馈已接收，正在转交。');
    }
  }
  const pending = !!preview && (preview.status === 'local' || preview.status === 'pending');
  const channel: FeedbackChannel | undefined = preview && preview.status !== 'local' ? 'online' : delivery?.channel;
  const handedOff = !!preview?.handoff && preview.handoff.state !== 'saved';
  const welink = channel === 'welink';
  const transport = feedbackImageTransportNote(channel, preview ? preview.attachments?.length ?? 0 : drafts.length, !!preview);
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
  const attachments = <FeedbackAttachmentSection
    images={preview ? savedThumbs(preview.attachments ?? [], opened, preview.payload.feedbackId) : thumbsFrom(drafts)}
    error={preview ? imageLoadError : imageError}
    notice={transport}
    canEdit={!preview}
    disabled={busy}
    onAdd={() => picker.current?.click()}
    onRemove={removeImage} />;
  return <section className="settings-section feedback-panel" aria-label="问题反馈">
    <header className="row feedback-heading">
      <h2 id={`${id}-title`} ref={previewTitle} tabIndex={preview ? -1 : undefined}>
        {preview ? '核对反馈内容' : <label htmlFor={`${id}-description`}>问题描述</label>}
      </h2>
      {preview ? <span className="feedback-status" role="status">{feedbackStatus(preview)}</span>
        : <span className="feedback-limit">{description.length} / 4000</span>}
    </header>
    {!preview ? <form noValidate onPasteCapture={event => { void onPaste(event); }} onSubmit={event => { event.preventDefault(); void act(async () => {
      if (!description.trim()) { setError('请填写问题描述。'); input.current?.focus(); return; }
      await adding.current;
      const images = draftsRef.current.map(({ key: imageKey, originalName, source, data }) => ({ key: imageKey, name: originalName, source, data }));
      setPreview(await api.prepare(description, context, images)); setHistory(await api.list()); setImageError('');
    }); }}>
      <textarea ref={input} id={`${id}-description`} maxLength={4000} rows={4} value={description} disabled={busy} style={{ resize: 'none' }}
        placeholder="你做了什么？期望发生什么？实际出现了什么？"
        aria-describedby={`${id}-help`} onChange={event => { const value = event.target.value; setDescription(value); try { localStorage.setItem(key, value); } catch { setError('无法保存本机草稿，请先复制问题描述。'); } }} />
      {attachments}
      <input ref={picker} className="visually-hidden" tabIndex={-1} aria-hidden="true" type="file" multiple
        accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif"
        onChange={event => { const list = [...event.target.files ?? []]; event.target.value = ''; if (list.length) void addFiles(list, 'file'); }} />
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
        {feedbackMessageParts(feedbackSummary(preview.payload, delivery!.receiver, preview.attachments ?? [])).map((part, index) => <pre key={index} className="feedback-summary">{part}</pre>)}
      </details>}
      <details className="feedback-diagnostics"><summary>查看将附带的诊断</summary><pre>{JSON.stringify(preview.payload.diagnostics, null, 2)}</pre></details>
      <p className="feedback-muted">内容仅供维护人员查看。请检查描述和诊断中是否还包含不希望发送的信息。</p>
      {!!preview.attachments?.length && attachments}
      {preview.error && <p role="alert" className="feedback-error">{preview.error}</p>}
      {preview.handoff && <p className="feedback-muted">完整反馈包：{preview.handoff.packagePath}</p>}
      {preview.handoff?.error && <p role="alert" className="feedback-error">{preview.handoff.error}</p>}
      <div className="feedback-actions">
        <button type="button" disabled={busy} onClick={() => { setPreview(undefined); requestAnimationFrame(() => input.current?.focus()); }}>返回填写</button>
        <button type="button" disabled={busy} onClick={() => void act(async () => { await api.copy(preview.payload.feedbackId); setNotice(preview.attachments?.length ? '已复制反馈文字和诊断。图片在反馈包中，尚未发送。' : '已复制反馈内容，尚未发送。'); })}>复制反馈</button>
        <button type="button" disabled={busy} onClick={() => void act(async () => { if (await api.export(preview.payload.feedbackId)) setNotice(preview.attachments?.length ? '反馈包已保存，内含图片，尚未因此发送。内网可将反馈包交给维护人。' : '反馈包已保存，尚未因此发送。内网可将反馈包交给维护人。'); })}>保存反馈包</button>
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
