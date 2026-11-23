import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DictationState, WriteTiming } from '../../shared/desktop';
import { Capture } from './capture';

function joined(lines: string[]) {
  return lines.reduce((text, line) => text + (/[a-z\d.,!?]$/i.test(text) && /^[a-z\d]/i.test(line) ? ' ' : '') + line, '');
}

export function useCapture({ phase, sessionId, clearRevision }: DictationState, timing: WriteTiming) {
  const running = useRef<{ id: string; capture: Capture; stopping: boolean } | undefined>(undefined);
  const [levels, setLevels] = useState<number[]>(Array(25).fill(0));
  const [lines, setLines] = useState<string[]>([]);
  const [draft, setDraft] = useState('');

  useLayoutEffect(() => { setLines([]); setDraft(''); }, [clearRevision]);

  useEffect(() => {
    const desktop = window.echoBuddy;
    if (!sessionId) {
      setDraft('');
      return;
    }
    if (phase === 'preparing' && running.current?.id !== sessionId) {
      setLines([]); setDraft(''); setLevels(Array(25).fill(0));
      const capture = new Capture(sessionId, {
        level: value => setLevels(old => [...old.slice(1), value]),
        words: (confirmed, partial) => { setLines(confirmed); setDraft(partial); },
        progress: timing === 'streaming' ? confirmed => {
          void desktop.writeProgress(sessionId, joined(confirmed)).catch(() => {});
        } : undefined,
        ended: () => { if (!running.current?.stopping) void desktop.toggle(); },
      });
      const current = { id: sessionId, capture, stopping: false };
      running.current = current;
      void capture.start().then(() => {
        if (running.current === current && !current.stopping) return desktop.recording(sessionId);
      }).catch(async error => {
        if (running.current !== current || current.stopping) return;
        current.stopping = true;
        await capture.stop().catch(() => {});
        const message = error?.name === 'NotAllowedError' ? '请在 Windows 隐私设置里允许桌面应用访问麦克风。'
          : error?.name === 'NotFoundError' ? '未找到麦克风，请接入后重试。'
          : '无法开始录音，请检查麦克风后重试。';
        await desktop.complete(sessionId, '', message);
        if (running.current === current) running.current = undefined;
      });
    }
    if (phase === 'finishing') {
      const current = running.current;
      if (current?.id === sessionId && !current.stopping) {
        current.stopping = true;
        void (async () => {
          try {
            const text = joined(await current.capture.stop());
            await desktop.complete(sessionId, text);
          } catch {
            await desktop.complete(sessionId, joined(current.capture.confirmed()), '本地转写未完成，已保留识别出的文字。');
          } finally {
            if (running.current === current) running.current = undefined;
          }
        })();
      } else if (!current) void desktop.complete(sessionId, '');
    }
  }, [phase, sessionId, timing]);

  return { levels, lines, draft };
}
