import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { FolderOpen, Pause, Play, Trash } from '@phosphor-icons/react';
import { MEETING_SOURCE_NAMES, type MeetingLibrary, type MeetingLine, type MeetingRecord, type MeetingSpeaker } from '../../shared/meeting-contracts';

const desktop = window.echoBuddy;
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', year: 'numeric' });

function clock(seconds: number, tenths = false): string {
  const whole = Math.max(0, Math.floor(seconds));
  const time = [Math.floor(whole / 60), whole % 60].map(value => String(value).padStart(2, '0')).join(':');
  return tenths ? time + '.' + Math.floor((seconds - whole) * 10 + .00001) : time;
}

function dayOf(time: number): string {
  const today = new Date();
  const date = new Date(time).toDateString();
  if (date === today.toDateString()) return '今天';
  today.setDate(today.getDate() - 1);
  return date === today.toDateString() ? '昨天' : dateFormat.format(time);
}

function speakerName(speaker: MeetingSpeaker): string {
  if (speaker === 'self') return '我';
  if (speaker === 'unknown') return '未确认';
  return '说话人 ' + (speaker < 26 ? String.fromCharCode(65 + speaker) : speaker + 1);
}

function recordStatus(record: MeetingRecord): string {
  if (record.status === 'queued') return '等待转写';
  if (record.status === 'transcribing') return '正在转写';
  if (record.status === 'failed') return '转写失败';
  return '转写完成';
}

export function MeetingRecords({ selected, onSelect }: { selected?: string; onSelect: (id: string) => void }) {
  const [library, setLibrary] = useState<MeetingLibrary | null>(null);
  const layout = useRef<HTMLElement>(null);
  const previousId = useRef<string | undefined>(undefined);
  useEffect(() => {
    let mounted = true, notified = false;
    const sync = desktop.onMeetingLibrary(value => { notified = true; setLibrary(value); });
    void desktop.meetingLibrary().then(value => {
      if (mounted && !notified) setLibrary(value);
    }).catch(() => { if (mounted && !notified) setLibrary({ records: [], error: '无法读取会议记录。' }); });
    return () => { mounted = false; sync(); };
  }, []);

  const records = library?.records ?? [];
  const record = records.find(item => item.id === selected) ?? records[0];
  const activeId = record?.id;
  useLayoutEffect(() => {
    const oldId = previousId.current;
    previousId.current = activeId;
    if (oldId && !records.some(item => item.id === oldId)) {
      layout.current?.querySelector<HTMLElement>('.meeting-history-item[aria-current="true"], .meeting-empty')?.focus();
    }
  }, [activeId, records]);

  const groups = new Map<string, MeetingRecord[]>();
  for (const item of records) {
    const day = dayOf(item.createdAt);
    const group = groups.get(day) ?? [];
    group.push(item);
    groups.set(day, group);
  }
  return <section className="meeting-layout" ref={layout} aria-label="会议记录">
    {!!groups.size && <nav className="meeting-history" aria-label="会议列表">
      {[...groups].map(([day, items]) => <section className="meeting-day" key={day}>
        <h2>{day}</h2>
        {items.map(item => <button type="button" className="meeting-history-item" key={item.id}
          aria-current={item.id === record?.id ? 'true' : undefined} onClick={() => onSelect(item.id)}>
          <strong>{item.title}</strong>
          <span>{item.status === 'ready' ? clock(item.durationMs / 1000) : recordStatus(item)}</span>
        </button>)}
      </section>)}
    </nav>}
    {record ? <MeetingReview key={record.id} record={record} />
      : <div className="meeting-details meeting-empty" role="status" tabIndex={-1}>
        <strong>{library?.error || (library ? '暂无会议记录' : '正在读取会议记录…')}</strong>
        {library && !library.error && <p>在浮窗的「录音模式」选择「会议录音」，停录后可在这里回看。</p>}
      </div>}
  </section>;
}

function MeetingReview({ record }: { record: MeetingRecord }) {
  const [titleMode, setTitleMode] = useState<'view' | 'edit' | 'saving' | 'error'>('view');
  const [lines, setLines] = useState<MeetingLine[]>([]);
  const [detailError, setDetailError] = useState('');
  const [folderError, setFolderError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playError, setPlayError] = useState('');
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const titleButton = useRef<HTMLButtonElement>(null);
  const restoreTitleFocus = useRef(false);
  const player = useRef<HTMLAudioElement>(null);
  const secondTrack = useRef<HTMLAudioElement>(null);
  const playbackRequest = useRef(0);
  const duration = record.durationMs / 1000;
  const { id, processedMs, status } = record;

  useLayoutEffect(() => {
    if (titleMode === 'view' && restoreTitleFocus.current) {
      restoreTitleFocus.current = false;
      titleButton.current?.focus();
    }
  }, [titleMode]);

  useEffect(() => {
    let current = true;
    void desktop.meetingDetail(id).then(detail => {
      if (current) {
        setLines(detail?.lines.filter(line => line.text) ?? []);
        setDetailError('');
      }
    }).catch(() => { if (current) setDetailError('无法读取这场会议的转写。'); });
    return () => { current = false; };
  }, [id, processedMs, status]);

  useEffect(() => {
    const first = player.current, second = secondTrack.current;
    return () => { playbackRequest.current++; first?.pause(); second?.pause(); };
  }, []);

  function closeTitleEditor(refocus: boolean) {
    restoreTitleFocus.current = refocus;
    setTitleMode('view');
  }

  async function saveTitle(input: HTMLInputElement, refocus = false) {
    if (titleMode === 'saving') return;
    const title = input.value.trim();
    if (!title || title === record.title) {
      closeTitleEditor(refocus);
      return;
    }
    setTitleMode('saving');
    try {
      await desktop.renameMeeting(id, title);
      closeTitleEditor(refocus && document.activeElement === input);
    } catch {
      setTitleMode('error');
    }
  }

  function seek(seconds: number) {
    const next = Math.min(duration, Math.max(0, seconds));
    if (player.current) player.current.currentTime = next;
    if (secondTrack.current) secondTrack.current.currentTime = next;
    setTime(next);
  }

  function pause() {
    playbackRequest.current++;
    player.current?.pause();
    secondTrack.current?.pause();
    setPlaying(false);
  }

  function syncTime() {
    const primary = player.current, secondary = secondTrack.current;
    if (!primary) return;
    setTime(primary.currentTime);
    if (secondary && !primary.paused && !primary.seeking && !secondary.seeking &&
        Math.abs(primary.currentTime - secondary.currentTime) > .18) secondary.currentTime = primary.currentTime;
  }

  async function play(seconds?: number) {
    const primary = player.current, secondary = secondTrack.current;
    if (!primary) return;
    const request = ++playbackRequest.current;
    setPlayError('');
    try {
      if (seconds !== undefined || primary.ended) seek(seconds ?? 0);
      else if (secondary) secondary.currentTime = primary.currentTime;
      setPlaying(true);
      await Promise.all([primary.play(), secondary?.play()]);
    } catch {
      if (request !== playbackRequest.current) return;
      pause();
      setPlayError('无法播放这场会议的录音。');
    }
  }

  async function openFolder() {
    try { setFolderError(await desktop.openMeetingFolder(id)); }
    catch { setFolderError('无法打开录音文件夹。'); }
  }

  async function deleteRecording() {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(false);
    pause();
    try {
      await desktop.deleteMeeting(id);
      deleteDialog.current?.close();
    } catch { setDeleteError(true); }
    finally { setDeleting(false); }
  }

  async function retry() {
    setRetrying(true);
    try { await desktop.retryMeeting(id); }
    catch { setDetailError('无法开始重试，请检查录音文件夹。'); }
    finally { setRetrying(false); }
  }

  const progress = status === 'transcribing' && processedMs > 0 ? ' · ' + Math.min(99, Math.floor(processedMs / record.durationMs * 100)) + '%' : '';
  return <section className="meeting-details" aria-labelledby="meeting-title">
    <div className="meeting-detail-header">
      <div className="meeting-heading">
        <h2 id="meeting-title" aria-label={record.title}>
          {titleMode === 'view' ? <button type="button" className="meeting-title-control" ref={titleButton}
            aria-label={record.title + '，编辑会议名称'} title="编辑会议名称" onClick={() => setTitleMode('edit')}>
            {record.title}
          </button> : <input type="text" className="meeting-title-control" aria-label="会议名称"
            aria-describedby={titleMode === 'error' ? 'meeting-title-error' : undefined}
            defaultValue={record.title} readOnly={titleMode === 'saving'} autoFocus
            onFocus={event => event.currentTarget.select()}
            onBlur={event => void saveTitle(event.currentTarget)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                void saveTitle(event.currentTarget, true);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                if (titleMode !== 'saving') closeTitleEditor(true);
              }
            }} />}
        </h2>
        <p>{titleMode === 'error' ? <span className="meeting-title-error" id="meeting-title-error" role="alert">名称未保存，请重试。</span>
          : record.sources.map(source => MEETING_SOURCE_NAMES[source]).join(' · ')}</p>
      </div>
      <div className="meeting-header-actions">
        <button type="button" className="meeting-folder" onClick={() => void openFolder()}>
          <FolderOpen size={17} aria-hidden="true" />打开录音文件夹
        </button>
        <button type="button" className="meeting-delete" onClick={() => {
          setDeleteError(false);
          deleteDialog.current?.showModal();
        }}><Trash size={17} aria-hidden="true" />删除录音</button>
      </div>
    </div>
    <dialog ref={deleteDialog} className="meeting-delete-dialog" role="alertdialog"
      aria-labelledby="meeting-delete-title" aria-describedby="meeting-delete-description"
      onCancel={event => { if (deleting) event.preventDefault(); }}>
      <h3 id="meeting-delete-title">删除录音？</h3>
      <p id="meeting-delete-description">「{record.title}」的录音和转写会一起移到 Windows 回收站。</p>
      {deleteError && <p className="meeting-warning" role="alert">无法将录音移到回收站，请重试。</p>}
      <div className="meeting-delete-actions">
        <button type="button" disabled={deleting} onClick={() => deleteDialog.current?.close()}>取消</button>
        <button type="button" className="meeting-delete-confirm" disabled={deleting} onClick={() => void deleteRecording()}>
          {deleting ? '正在删除…' : '移到回收站'}
        </button>
      </div>
    </dialog>
    {folderError && <p className="meeting-warning" role="status">{folderError}</p>}
    <div className="meeting-player" role="group" aria-label="录音回放">
      {record.sources.map((source, index) => <audio key={source} preload="metadata" ref={index === 0 ? player : secondTrack}
        src={'/meeting-audio/' + id + '/' + source + '.wav'} onTimeUpdate={index === 0 ? syncTime : undefined}
        onEnded={index === 0 ? pause : undefined} onError={() => { pause(); setPlayError('无法读取' + MEETING_SOURCE_NAMES[source] + '音轨。'); }} />)}
      <button type="button" className="meeting-play" aria-label={playing ? '暂停录音' : '播放录音'}
        onClick={() => { if (playing) pause(); else void play(); }}>
        {playing ? <Pause size={19} weight="fill" aria-hidden="true" /> : <Play size={19} weight="fill" aria-hidden="true" />}
      </button>
      <input type="range" className="meeting-progress" aria-label="录音进度" aria-valuetext={clock(time)}
        min={0} max={duration} step={.01} value={time} onChange={event => seek(event.currentTarget.valueAsNumber)}
        style={{ '--played': (time / duration * 100) + '%' } as CSSProperties} />
      <span className="meeting-time">{clock(time)} / {clock(duration)}</span>
    </div>
    {playError && <p className="meeting-warning" role="status">{playError}</p>}
    {record.warning && <p className="meeting-warning" role="status">{record.warning}</p>}
    <section className="meeting-transcript" aria-labelledby="meeting-transcript-title">
      <div className="meeting-transcript-header">
        <h3 id="meeting-transcript-title">转写结果</h3>
        <span role="status">{recordStatus(record)}{progress}</span>
        {status === 'failed' && <button type="button" className="meeting-retry" disabled={retrying} onClick={() => void retry()}>重试转写</button>}
      </div>
      {detailError && <p className="meeting-warning" role="status">{detailError}</p>}
      {record.error && <p className="meeting-warning" role="status">{record.error}</p>}
      {lines.length ? <ol aria-label="按时间排列的转写">
        {lines.map(line => {
          const start = line.startMs / 1000, end = line.endMs / 1000;
          const active = time >= start && time < end;
          return <li key={line.id}>
            <button type="button" className="meeting-transcript-line" aria-current={active ? 'true' : undefined}
              onClick={() => void play(start)}>
              <time>{clock(start, true)}</time>
              <strong data-self={line.speaker === 'self'}>{speakerName(line.speaker)}</strong>
              <span className="meeting-line-source">{MEETING_SOURCE_NAMES[line.source]}</span>
              <span className="meeting-line-text">{line.text}</span>
            </button>
          </li>;
        })}
      </ol> : status === 'ready' && !detailError && <p className="meeting-subtle">这场录音没有识别到语音。</p>}
    </section>
  </section>;
}
