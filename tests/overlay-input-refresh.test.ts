import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bindOverlaySessionRefresh, createOverlayInputRefresh, overlaySessionSignals,
  type OverlaySessionSignal,
} from '../electron/overlay-input-refresh';

function harness(canRefresh: () => boolean = () => true) {
  const queued: Array<() => void> = [];
  let refreshes = 0;
  const refresh = createOverlayInputRefresh(() => { refreshes += 1; }, run => queued.push(run), canRefresh);
  return {
    signal: refresh.signal,
    flush() {
      const jobs = queued.splice(0);
      jobs.forEach(job => job());
      return jobs.length;
    },
    get refreshes() { return refreshes; },
    get queued() { return queued.length; },
  };
}

test('show, restore, and a display change do not refresh unless one is armed', () => {
  const win = harness();
  win.signal('show');
  win.signal('restore');
  win.signal('display-metrics-changed');
  win.signal('resume');
  assert.equal(win.flush(), 0);
  assert.equal(win.refreshes, 0);
});

test('minimize still refreshes once when the window is shown or restored', () => {
  const shown = harness();
  shown.signal('minimize');
  shown.signal('minimize');
  assert.equal(shown.queued, 0);
  shown.signal('show');
  shown.signal('restore');
  assert.equal(shown.queued, 1);
  assert.equal(shown.flush(), 1);
  assert.equal(shown.refreshes, 1);
  shown.signal('show');
  assert.equal(shown.flush(), 0);
  assert.equal(shown.refreshes, 1);

  const restored = harness();
  restored.signal('minimize');
  restored.signal('restore');
  restored.signal('show');
  assert.equal(restored.flush(), 1);
  assert.equal(restored.refreshes, 1);

  restored.signal('minimize');
  restored.signal('show');
  assert.equal(restored.flush(), 1);
  assert.equal(restored.refreshes, 2);
});

test('the refresh waits until the window is visible and not minimized', () => {
  let ready = false;
  const win = harness(() => ready);
  win.signal('minimize');
  win.signal('restore');
  assert.equal(win.flush(), 1);
  assert.equal(win.refreshes, 0);
  ready = true;
  win.signal('show');
  assert.equal(win.flush(), 1);
  assert.equal(win.refreshes, 1);
});

test('unlock refreshes a visible float that Win+L did not minimize', () => {
  const win = harness();
  win.signal('lock-screen');
  win.signal('show');
  win.signal('restore');
  assert.equal(win.flush(), 0);
  assert.equal(win.refreshes, 0);
  win.signal('unlock-screen');
  assert.equal(win.queued, 1);
  win.signal('display-metrics-changed');
  win.signal('unlock-screen');
  assert.equal(win.queued, 1);
  assert.equal(win.flush(), 1);
  assert.equal(win.refreshes, 1);
  win.signal('display-metrics-changed');
  win.signal('show');
  assert.equal(win.flush(), 0);
  assert.equal(win.refreshes, 1);
});

test('unlock still refreshes when the lock signal was missed', () => {
  const win = harness();
  win.signal('unlock-screen');
  assert.equal(win.flush(), 1);
  assert.equal(win.refreshes, 1);
});

test('a display change while locked or asleep waits for the session to return', () => {
  const locked = harness();
  locked.signal('lock-screen');
  locked.signal('display-metrics-changed');
  assert.equal(locked.flush(), 0);
  locked.signal('unlock-screen');
  assert.equal(locked.flush(), 1);
  assert.equal(locked.refreshes, 1);

  const asleep = harness();
  asleep.signal('suspend');
  asleep.signal('display-metrics-changed');
  assert.equal(asleep.flush(), 0);
  asleep.signal('resume');
  assert.equal(asleep.flush(), 1);
  assert.equal(asleep.refreshes, 1);
  asleep.signal('resume');
  assert.equal(asleep.flush(), 0);
  assert.equal(asleep.refreshes, 1);
});

test('resume while still locked waits for unlock, and unlock while suspended waits for resume', () => {
  const locked = harness();
  locked.signal('lock-screen');
  locked.signal('suspend');
  locked.signal('resume');
  assert.equal(locked.flush(), 0);
  locked.signal('unlock-screen');
  assert.equal(locked.flush(), 1);
  assert.equal(locked.refreshes, 1);
  locked.signal('resume');
  assert.equal(locked.flush(), 0);
  assert.equal(locked.refreshes, 1);

  const suspended = harness();
  suspended.signal('suspend');
  suspended.signal('lock-screen');
  suspended.signal('unlock-screen');
  assert.equal(suspended.flush(), 0);
  suspended.signal('resume');
  assert.equal(suspended.flush(), 1);
  assert.equal(suspended.refreshes, 1);
});

test('locking again before the refresh runs keeps it armed', () => {
  const win = harness();
  win.signal('lock-screen');
  win.signal('unlock-screen');
  assert.equal(win.queued, 1);
  win.signal('lock-screen');
  assert.equal(win.flush(), 1);
  assert.equal(win.refreshes, 0);
  win.signal('unlock-screen');
  assert.equal(win.flush(), 1);
  assert.equal(win.refreshes, 1);
});

test('a minimized float stays armed through unlock until it is actually visible', () => {
  let visible = false;
  const win = harness(() => visible);
  win.signal('minimize');
  win.signal('lock-screen');
  win.signal('unlock-screen');
  assert.equal(win.flush(), 1);
  assert.equal(win.refreshes, 0);
  visible = true;
  win.signal('restore');
  assert.equal(win.flush(), 1);
  assert.equal(win.refreshes, 1);
});

test('session binding forwards lock, unlock, sleep, resume, and display changes once', () => {
  assert.deepEqual([...overlaySessionSignals], [
    'lock-screen',
    'unlock-screen',
    'suspend',
    'resume',
    'display-metrics-changed',
  ]);
  const added = new Map<OverlaySessionSignal, () => void>();
  const removed = new Map<OverlaySessionSignal, () => void>();
  const seen: OverlaySessionSignal[] = [];
  const stop = bindOverlaySessionRefresh({
    on(signal, listener) { added.set(signal, listener); },
    off(signal, listener) { removed.set(signal, listener); },
  }, signal => seen.push(signal));
  assert.deepEqual([...added.keys()], [...overlaySessionSignals]);
  for (const signal of overlaySessionSignals) added.get(signal)!();
  assert.deepEqual(seen, [...overlaySessionSignals]);
  stop();
  for (const signal of overlaySessionSignals) assert.equal(removed.get(signal), added.get(signal));
});
