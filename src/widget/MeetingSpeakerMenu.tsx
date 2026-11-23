import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { PencilSimple, Play, X } from '@phosphor-icons/react';
import type { MeetingRecord, MeetingSpeaker, NamedMeetingSpeaker } from '../../shared/meeting-contracts';

export interface SpeakerSummary {
  speaker: NamedMeetingSpeaker;
  count: number;
  startMs: number;
}

export function speakerName(speaker: MeetingSpeaker, names?: MeetingRecord['speakerNames'], defaults?: MeetingRecord['speakerNames']): string {
  if (speaker === 'unknown') return '未确认';
  const name = names?.[speaker] || defaults?.[speaker];
  if (name) return name;
  if (typeof speaker === 'number') return '说话人 ' + (speaker < 26 ? String.fromCharCode(65 + speaker) : speaker + 1);
  return speaker === 'self' ? '我' : '说话人';
}

function sampleTime(startMs: number) {
  const seconds = Math.floor(startMs / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(unit => String(unit).padStart(2, '0')).join(':');
}

export function MeetingSpeakerMenu({ record, speakers, speakerDefaults, initialSpeaker, listButton, onClose, onPlay }: {
  record: MeetingRecord;
  speakers: SpeakerSummary[];
  speakerDefaults: MeetingRecord['speakerNames'];
  initialSpeaker: NamedMeetingSpeaker | null;
  listButton: RefObject<HTMLButtonElement | null>;
  onClose: (refocus: boolean) => void;
  onPlay: (seconds: number) => void;
}) {
  const [draft, setDraft] = useState(() => initialSpeaker === null ? null : {
    speaker: initialSpeaker, name: speakerName(initialSpeaker, record.speakerNames, speakerDefaults),
  });
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'error'>('idle');
  const menu = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const returnToSpeaker = useRef<NamedMeetingSpeaker | null>(null);
  const editingSpeaker = draft?.speaker ?? null;
  const saving = saveState === 'saving';

  useLayoutEffect(() => {
    if (editingSpeaker !== null) {
      const entry = input.current?.closest('li');
      const list = entry?.parentElement;
      if (entry && list) {
        const row = entry.getBoundingClientRect(), viewport = list.getBoundingClientRect();
        const end = Math.min(row.bottom, row.top + viewport.height);
        list.scrollTop += row.top < viewport.top ? row.top - viewport.top : Math.max(0, end - viewport.bottom);
      }
      input.current?.focus({ preventScroll: true });
      input.current?.select();
    } else {
      const editButton = returnToSpeaker.current === null ? null :
        menu.current?.querySelector<HTMLButtonElement>(`[data-edit-speaker="${returnToSpeaker.current}"]`);
      (editButton ?? menu.current)?.focus({ preventScroll: true });
    }
  }, [editingSpeaker]);

  useEffect(() => {
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !listButton.current?.contains(event.target)) {
        onClose(false);
      }
    }
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [listButton, onClose]);

  function finishEdit(speaker: NamedMeetingSpeaker) {
    returnToSpeaker.current = speaker;
    setDraft(null);
    setSaveState('idle');
  }

  async function save(name: string | null) {
    if (!draft || saving || name === '') return;
    const { speaker } = draft;
    setSaveState('saving');
    try {
      if (name !== speakerName(speaker, record.speakerNames, speakerDefaults)) {
        const defaultName = speakerName(speaker, speakerDefaults);
        await window.echoBuddy.renameMeetingSpeaker(record.id, speaker, name === defaultName ? null : name);
      }
      finishEdit(speaker);
    } catch { setSaveState('error'); }
  }

  return <div id="meeting-speaker-menu" className="meeting-speaker-menu" role="dialog" aria-labelledby="meeting-speaker-title"
    tabIndex={-1} ref={menu} onKeyDown={event => {
      if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      if (saving) return;
      if (draft) finishEdit(draft.speaker);
      else onClose(true);
    }}>
    <header className="meeting-speaker-menu-header">
      <h3 id="meeting-speaker-title">说话人</h3>
      <button type="button" className="meeting-speaker-icon" aria-label="关闭说话人名单" onClick={() => onClose(true)}>
        <X size={16} aria-hidden="true" />
      </button>
    </header>
    {speakers.length ? <ul className="meeting-speaker-list" aria-label="本场说话人">
      {speakers.map(({ speaker, count, startMs }) => {
        const name = speakerName(speaker, record.speakerNames, speakerDefaults), time = sampleTime(startMs);
        const editing = draft?.speaker === speaker;
        return <li key={speaker}>
          <div className="meeting-speaker-entry" data-editing={editing}>
            <strong title={name}>{name}</strong>
            <span>{count} 段</span>
            <button type="button" className="meeting-speaker-sample" aria-label={`从 ${time} 播放${name}的发言`}
              onClick={() => onPlay(startMs / 1000)}>
              <Play size={13} weight="fill" aria-hidden="true" /><time>{time}</time>
            </button>
            {!editing && <button type="button" className="meeting-speaker-icon" data-edit-speaker={speaker}
              aria-label={`给${name}改名`} title="改名" disabled={saving} onClick={() => {
                setSaveState('idle');
                setDraft({ speaker, name });
              }}><PencilSimple size={17} aria-hidden="true" /></button>}
          </div>
          {editing && <div className="meeting-speaker-editor">
            <input type="text" ref={input} className="meeting-speaker-name" aria-label="说话人名称"
              aria-describedby="meeting-speaker-scope" value={draft.name} readOnly={saving}
              onChange={event => setDraft({ speaker, name: event.currentTarget.value })}
              onKeyDown={event => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                event.preventDefault();
                void save(draft.name.trim());
              }} />
            <div className="meeting-speaker-edit-footer">
              <span id="meeting-speaker-scope">本场 {count} 段发言将同步更新</span>
              <button type="button" className="meeting-speaker-cancel" disabled={saving} onClick={() => finishEdit(speaker)}>取消</button>
              <button type="button" className="meeting-speaker-save" disabled={saving || !draft.name.trim()}
                onClick={() => void save(draft.name.trim())}>保存</button>
            </div>
            {record.speakerNames?.[speaker] && <button type="button" className="meeting-speaker-reset" disabled={saving}
              onClick={() => void save(null)}>恢复默认名称</button>}
            {saveState === 'error' && <div className="meeting-warning" role="alert">名称未保存，请重试。</div>}
          </div>}
        </li>;
      })}
    </ul> : <div className="meeting-speaker-empty">本场暂无已确认的说话人。</div>}
  </div>;
}
