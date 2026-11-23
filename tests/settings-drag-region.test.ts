import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { watchSettingsDragRefresh, type SettingsDragWindow } from '../electron/settings-drag-refresh';
import { refreshSettingsDragRegion, type DragRegionTarget } from '../src/widget/settings-drag-region';

function header(initialWidth = '', measured = 320) {
  const log: string[] = [];
  let width = initialWidth;
  let region: string | undefined;
  let layouts = 0;
  let failLayout = false;
  const target: DragRegionTarget = {
    style: {
      get width() { return width; },
      set width(value: string) {
        width = value;
        log.push(`width:${value}`);
      },
      setProperty(property: string, value: string) {
        if (property === '-webkit-app-region') region = value;
        log.push(`set ${property} ${value}`);
      },
      removeProperty(property: string) {
        if (property === '-webkit-app-region') region = undefined;
        log.push(`remove ${property}`);
        return '';
      },
    },
    get offsetWidth() { return measured; },
    get offsetHeight() {
      layouts += 1;
      log.push(`layout width=${width} region=${region ?? 'stylesheet'}`);
      if (failLayout) throw new Error('layout failed');
      return 42;
    },
  };
  return {
    target, log,
    get width() { return width; },
    get region() { return region; },
    get layouts() { return layouts; },
    failNextLayout() { failLayout = true; },
  };
}

test('drag refresh republishes regions and leaves the title bar on its stylesheet rules', () => {
  const bar = header();
  const jobs: Array<() => void> = [];
  refreshSettingsDragRegion(bar.target, job => jobs.push(job));
  assert.equal(jobs.length, 1);
  assert.equal(bar.region, undefined);
  assert.equal(bar.width, '');
  assert.deepEqual(bar.log, [
    'set -webkit-app-region no-drag',
    'width:320px',
    'layout width=320px region=no-drag',
    'width:',
    'remove -webkit-app-region',
    'layout width= region=stylesheet',
  ]);

  jobs[0]();
  assert.equal(bar.region, undefined);
  assert.equal(bar.width, '');
  assert.equal(bar.log.filter(line => line.startsWith('set ')).every(line => line.endsWith('no-drag')), true);
  assert.equal(bar.log.includes('set -webkit-app-region drag'), false);
});

test('an inline width is restored, and a width that is already the border box still forces layout', () => {
  const pinned = header('320px');
  refreshSettingsDragRegion(pinned.target, () => {});
  assert.equal(pinned.width, '320px');
  assert.equal(pinned.log.includes('width:321px'), true);
  assert.equal(pinned.log.filter(line => line.startsWith('width:')).at(-1), 'width:320px');

  const custom = header('10px', 400);
  refreshSettingsDragRegion(custom.target, () => {});
  assert.equal(custom.width, '10px');
  assert.equal(custom.log.includes('width:400px'), true);
});

test('a newer refresh supersedes the previous frame, and a layout error still clears the inline override', () => {
  const bar = header('6px');
  const jobs: Array<() => void> = [];
  refreshSettingsDragRegion(bar.target, job => jobs.push(job));
  const layoutsAfterFirst = bar.layouts;
  refreshSettingsDragRegion(bar.target, job => jobs.push(job));
  jobs[0]();
  assert.equal(bar.layouts, layoutsAfterFirst + 2);
  jobs[1]();
  assert.equal(bar.region, undefined);
  assert.equal(bar.width, '6px');

  const broken = header('8px');
  broken.failNextLayout();
  assert.throws(() => refreshSettingsDragRegion(broken.target, () => {}), /layout failed/);
  assert.equal(broken.region, undefined);
  assert.equal(broken.width, '8px');
});

test('settings title-bar drag and button no-drag stay in the stylesheet', () => {
  const css = readFileSync(new URL('../src/widget/widget.css', import.meta.url), 'utf8');
  assert.match(css, /button \{[^}]*-webkit-app-region:\s*no-drag/);
  assert.match(css, /\.settings-header \{[^}]*-webkit-app-region:\s*drag/);
});

function windowHarness() {
  const listeners: Record<'minimize' | 'restore' | 'show', Array<() => void>> = {
    minimize: [], restore: [], show: [],
  };
  let minimized = false;
  let destroyed = false;
  const queued: Array<() => void> = [];
  let refreshes = 0;
  const win: SettingsDragWindow = {
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    onMinimize: listener => { listeners.minimize.push(listener); },
    onRestore: listener => { listeners.restore.push(listener); },
    onShow: listener => { listeners.show.push(listener); },
  };
  watchSettingsDragRefresh(win, () => { refreshes += 1; }, run => queued.push(run));
  return {
    minimize() { minimized = true; listeners.minimize.forEach(listener => listener()); },
    restore() { minimized = false; listeners.restore.forEach(listener => listener()); },
    showWhileMinimized() { listeners.show.forEach(listener => listener()); },
    show() { minimized = false; listeners.show.forEach(listener => listener()); },
    destroy() { destroyed = true; },
    flush() {
      const jobs = queued.splice(0);
      jobs.forEach(job => job());
      return jobs.length;
    },
    get refreshes() { return refreshes; },
    get queued() { return queued.length; },
  };
}

test('showing or restoring without a minimize does not refresh drag regions', () => {
  const win = windowHarness();
  win.show();
  win.restore();
  assert.equal(win.flush(), 0);
  assert.equal(win.refreshes, 0);
});

test('each minimize path refreshes once after the window is shown from the taskbar', () => {
  const fromButton = windowHarness();
  fromButton.minimize();
  fromButton.restore();
  assert.equal(fromButton.refreshes, 0);
  assert.equal(fromButton.flush(), 1);
  assert.equal(fromButton.refreshes, 1);
  fromButton.show();
  assert.equal(fromButton.flush(), 0);
  assert.equal(fromButton.refreshes, 1);

  const fromMenu = windowHarness();
  fromMenu.minimize();
  fromMenu.show();
  assert.equal(fromMenu.flush(), 1);
  assert.equal(fromMenu.refreshes, 1);

  const fromTaskbar = windowHarness();
  fromTaskbar.minimize();
  fromTaskbar.restore();
  fromTaskbar.show();
  assert.equal(fromTaskbar.queued, 1);
  assert.equal(fromTaskbar.flush(), 1);
  assert.equal(fromTaskbar.refreshes, 1);
});

test('a refresh waits until the window is actually restored, and is skipped if the window is gone', () => {
  const waiting = windowHarness();
  waiting.minimize();
  waiting.showWhileMinimized();
  assert.equal(waiting.flush(), 1);
  assert.equal(waiting.refreshes, 0);
  waiting.restore();
  assert.equal(waiting.flush(), 1);
  assert.equal(waiting.refreshes, 1);

  const gone = windowHarness();
  gone.minimize();
  gone.restore();
  gone.destroy();
  assert.equal(gone.flush(), 1);
  assert.equal(gone.refreshes, 0);

  const again = windowHarness();
  again.minimize();
  again.restore();
  again.flush();
  again.minimize();
  again.show();
  again.flush();
  assert.equal(again.refreshes, 2);
});
