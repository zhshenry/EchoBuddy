import { useEffect, useRef, useState, type FormEvent } from 'react';
import { supportsHotwords, type Hotword, type HotwordChange } from '../../shared/hotwords';
import type { RecognitionLanguage } from '../../shared/speech-contracts';

type Edit = { original: string; text: string; aliases: string };

export function HotwordSettings({ languages }: { languages: RecognitionLanguage[] }) {
  const desktop = window.echoBuddy;
  const [hotwords, setHotwords] = useState<Hotword[] | null>(null);
  const [text, setText] = useState('');
  const [edit, setEdit] = useState<Edit | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ text: string; inEditor: boolean } | null>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const editInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void desktop.hotwords().then(words => { if (active) setHotwords(words); })
      .catch(() => { if (active) setError({ text: '无法读取热词，请重新打开语音设置。', inEditor: false }); });
    return () => { active = false; };
  }, [desktop]);
  useEffect(() => { editInput.current?.focus(); }, [edit?.original]);

  async function change(action: () => Promise<HotwordChange>, inEditor = false): Promise<boolean> {
    if (saving) return false;
    setSaving(true);
    setError(null);
    try {
      const result = await action();
      if ('error' in result) {
        setError({ text: result.error, inEditor });
        return false;
      }
      setHotwords(result.hotwords);
      return true;
    } catch {
      setError({ text: '无法保存热词，请重试。', inEditor });
      return false;
    } finally { setSaving(false); }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || !hotwords) return;
    if (await change(() => desktop.saveHotword({ text, aliases: [] }))) setText('');
    addInput.current?.focus();
  }

  function closeEdit() {
    setEdit(null);
    setError(null);
    addInput.current?.focus();
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!edit?.text.trim()) return;
    if (await change(() => desktop.saveHotword({ text: edit.text, aliases: edit.aliases.split('\n') }, edit.original), true)) closeEdit();
  }

  return <section className="settings-section" aria-labelledby="hotword-title">
    <h2 id="hotword-title">自定义热词</h2>
    <form className="hotword-controls" onSubmit={add}>
      <input ref={addInput} type="text" aria-label="输入词语" placeholder="输入词语" value={text} disabled={!hotwords}
        readOnly={saving} onChange={event => setText(event.target.value)} />
      <button type="submit" disabled={!hotwords || !text.trim() || saving}>添加</button>
    </form>
    <p className="settings-note" role="status">{supportsHotwords(languages)
      ? '热词保存在本机，下次短听写生效。'
      : '在「识别语言」里只选普通话、英语或这两项，即可使用热词。'}</p>
    {error && !error.inEditor && <p className="hotword-error" role="alert">{error.text}</p>}
    {hotwords && hotwords.length > 0 && <ul className="hotword-list" aria-label="已保存的热词">
      {hotwords.map(word => <li key={word.text}>
        {edit?.original === word.text ? <form className="hotword-editor" onSubmit={save} onKeyDown={event => {
          if (event.key !== 'Escape' || event.nativeEvent.isComposing || saving) return;
          event.stopPropagation();
          closeEdit();
        }}>
          <label>标准写法<input ref={editInput} value={edit.text} readOnly={saving}
            onChange={event => setEdit({ ...edit, text: event.target.value })} /></label>
          <label>常见误写（选填）<textarea rows={2} placeholder="每行填写一种写法" value={edit.aliases} readOnly={saving}
            onChange={event => setEdit({ ...edit, aliases: event.target.value })} /></label>
          {error?.inEditor && <p className="hotword-error" role="alert">{error.text}</p>}
          <div className="hotword-controls">
            <button type="button" className="hotword-secondary" disabled={saving} onClick={closeEdit}>取消</button>
            <button type="submit" disabled={!edit.text.trim() || saving}>保存</button>
          </div>
        </form> : <>
          <div className="hotword-spelling">
            <span>{word.text}</span>
            {word.aliases.length > 0 && <small>常见误写 · {word.aliases.join('、')}</small>}
          </div>
          <div className="hotword-controls">
            <button type="button" className="hotword-secondary" disabled={saving || !!edit} aria-label={`编辑 ${word.text}`} onClick={() => {
              setError(null);
              setEdit({ original: word.text, text: word.text, aliases: word.aliases.join('\n') });
            }}>编辑</button>
            <button type="button" className="hotword-secondary" disabled={saving || !!edit} aria-label={`删除 ${word.text}`}
              onClick={() => void change(() => desktop.deleteHotword(word.text))}>删除</button>
          </div>
        </>}
      </li>)}
    </ul>}
  </section>;
}
