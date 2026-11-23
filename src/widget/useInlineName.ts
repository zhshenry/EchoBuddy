import { useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';

export function useInlineName(value: string, saveName: (name: string) => Promise<void>, allowEmpty = false) {
  const [mode, setMode] = useState<'view' | 'edit' | 'saving' | 'error'>('view');
  const button = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const saving = useRef(false);

  useLayoutEffect(() => {
    if (mode === 'view' && restoreFocus.current) {
      restoreFocus.current = false;
      button.current?.focus({ preventScroll: true });
    }
  }, [mode]);

  function close(refocus: boolean) {
    restoreFocus.current = refocus;
    setMode('view');
  }

  async function commit(input: HTMLInputElement, refocus = false) {
    if (saving.current) return;
    const name = input.value.trim();
    if (name === value || (!allowEmpty && !name)) {
      close(refocus);
      return;
    }
    saving.current = true;
    setMode('saving');
    try {
      await saveName(name);
      close(refocus && document.activeElement === input);
    } catch { setMode('error'); }
    finally { saving.current = false; }
  }

  return {
    editing: mode !== 'view',
    error: mode === 'error',
    buttonProps: { type: 'button' as const, ref: button, onClick: () => setMode('edit') },
    inputProps: {
      type: 'text' as const, defaultValue: value, autoFocus: true, readOnly: mode === 'saving',
      onFocus: (event: FocusEvent<HTMLInputElement>) => event.currentTarget.select(),
      onBlur: (event: FocusEvent<HTMLInputElement>) => void commit(event.currentTarget),
      onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          void commit(event.currentTarget, true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          if (!saving.current) close(true);
        }
      },
    },
  };
}
