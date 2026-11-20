import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { AppUpdater } from 'electron-updater';
import { Dictation } from '../electron/dictation';
import { AppUpdates } from '../electron/updater';
import type { WriteResult } from '../electron/windows-input';

function setup(capture: (shortcut?: string) => Promise<boolean> = async () => true) {
  const writes: [string, boolean][] = [], clipboard: string[] = [], calls: string[] = [];
  let answer: WriteResult = 'written';
  const controller = new Dictation(
    { begin: id => { calls.push(id); }, transcribe: async () => '测试', end: id => { calls.push(id); } },
    { capture, clear() {}, async insert(text, original) { writes.push([text, original]); return answer; } },
    () => {}, text => clipboard.push(text),
  );
  return { controller, writes, clipboard, calls, next: (result: WriteResult) => { answer = result; } };
}

test('starting audio does not wait for either the original caret or the speech worker', async () => {
  let targetReady!: (found: boolean) => void;
  let capturedShortcut: string | undefined;
  const { controller, writes, calls } = setup(shortcut => new Promise(resolve => {
    capturedShortcut = shortcut;
    targetReady = resolve;
  }));
  controller.toggle('Ctrl+D');
  assert.equal(capturedShortcut, 'Ctrl+D');
  const id = controller.snapshot().sessionId!;
  assert.equal(controller.snapshot().phase, 'preparing');
  assert.deepEqual(calls, [id]);
  controller.recording(id);
  assert.equal(controller.snapshot().phase, 'recording');
  controller.toggle();
  assert.equal(controller.snapshot().phase, 'finishing');
  const finishing = controller.complete(id, ' 开头已经录到。 ');
  await controller.complete(id, '重复完成通知');
  assert.deepEqual(writes, []);
  assert.equal(controller.blocksInstall(), true);
  targetReady(true);
  await finishing;
  assert.deepEqual(writes, [['开头已经录到。', true]]);
  assert.deepEqual(calls, [id, id]);
  assert.equal(controller.blocksInstall(), false);
});

test('moved target leaves a recoverable transcript and blocks update installation', async () => {
  const { controller, writes, clipboard, next } = setup();
  controller.toggle();
  const id = controller.snapshot().sessionId!;
  next('moved');
  await controller.complete(id, '保留这句话。');
  assert.equal(controller.snapshot().pending, '保留这句话。');
  assert.equal(controller.blocksInstall(), true);
  controller.toggle();
  assert.equal(controller.snapshot().sessionId, null);
  await controller.insertPending();
  assert.deepEqual(writes, [['保留这句话。', true], ['保留这句话。', false]]);
  assert.equal(controller.snapshot().pending, '保留这句话。');
  controller.copyPending();
  assert.deepEqual(clipboard, ['保留这句话。']);
  assert.equal(controller.blocksInstall(), false);
});

test('empty and failed recordings never write into another app', async () => {
  const { controller, writes } = setup();
  controller.toggle();
  await controller.complete(controller.snapshot().sessionId!, '');
  controller.toggle();
  const id = controller.snapshot().sessionId!;
  await controller.complete(id, '已辨认的前半句', '后半句识别失败');
  assert.deepEqual(writes, []);
  assert.equal(controller.snapshot().pending, '已辨认的前半句');
  await assert.rejects(controller.transcribe(id, new Uint8Array()));
});

test('scheduled download cannot restart a busy session or restart twice', async () => {
  const driver = Object.assign(new EventEmitter(), {
    autoDownload: false, autoInstallOnAppQuit: true,
    checkForUpdates: async () => {
      driver.emit('update-available', { version: '0.1.1' });
      driver.emit('download-progress', { percent: 55.7 });
      return {};
    },
    quitAndInstall: () => { installs++; },
  });
  let installs = 0, busy = true;
  const updater = new AppUpdates('0.1.0', driver as unknown as AppUpdater, () => {}, () => busy);
  await updater.check();
  assert.equal(updater.snapshot().progress, 55);
  assert.equal(driver.autoDownload, true);
  assert.equal(driver.autoInstallOnAppQuit, false);
  driver.emit('update-downloaded', { version: '0.1.1' });
  assert.equal(updater.install(), false);
  busy = false;
  assert.equal(updater.install(), true);
  assert.equal(updater.install(), false);
  assert.equal(installs, 1);
});
