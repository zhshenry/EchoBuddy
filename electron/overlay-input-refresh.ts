export const overlaySessionSignals = [
  'lock-screen',
  'unlock-screen',
  'suspend',
  'resume',
  'display-metrics-changed',
] as const;

export type OverlaySessionSignal = typeof overlaySessionSignals[number];
export type OverlayInputSignal = OverlaySessionSignal | 'minimize' | 'show' | 'restore';

export type OverlaySessionEvents = {
  on(signal: OverlaySessionSignal, listener: () => void): void;
  off(signal: OverlaySessionSignal, listener: () => void): void;
};

/**
 * Windows leaves Chromium's mouse-input child hidden after a frameless
 * transparent window returns to the interactive desktop. Minimize already
 * arms one bounds refresh for the next show or restore. Win+L does not
 * minimize a skipTaskbar float, so lock-screen and suspend arm that same
 * refresh. Unlock runs it, including when the lock signal was missed. Resume
 * runs it after suspend. Neither runs while the screen is still locked or the
 * system is still suspended. A display change does not arm a refresh; it only
 * runs one that is already waiting, so an ordinary resolution change does not
 * move the window. The bounds update stays with the caller and is scheduled once.
 */
export function createOverlayInputRefresh(
  refresh: () => void,
  schedule: (run: () => void) => void = run => { setImmediate(run); },
  canRefresh: () => boolean = () => true,
): { signal(name: OverlayInputSignal): void } {
  let armed = false;
  let scheduled = false;
  let locked = false;
  let suspended = false;

  const run = () => {
    if (!armed || scheduled || locked || suspended) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      if (!armed || locked || suspended || !canRefresh()) return;
      armed = false;
      refresh();
    });
  };

  return {
    signal(name) {
      switch (name) {
        case 'minimize':
          armed = true;
          return;
        case 'lock-screen':
          locked = true;
          armed = true;
          return;
        case 'suspend':
          suspended = true;
          armed = true;
          return;
        case 'unlock-screen':
          locked = false;
          armed = true;
          run();
          return;
        case 'resume': {
          const wasSuspended = suspended;
          suspended = false;
          if (wasSuspended) armed = true;
          run();
          return;
        }
        case 'show':
        case 'restore':
        case 'display-metrics-changed':
          run();
          return;
        default: {
          const exhaustive: never = name;
          return exhaustive;
        }
      }
    },
  };
}

/** Subscribe the refresh to each session signal and return an unsubscribe. */
export function bindOverlaySessionRefresh(
  events: OverlaySessionEvents,
  signal: (name: OverlaySessionSignal) => void,
): () => void {
  const listeners = overlaySessionSignals.map(name => {
    const listener = () => signal(name);
    events.on(name, listener);
    return { name, listener };
  });
  return () => {
    for (const { name, listener } of listeners) events.off(name, listener);
  };
}
