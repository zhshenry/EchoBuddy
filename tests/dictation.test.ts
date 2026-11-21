import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { AppUpdater } from 'electron-updater';
import { Dictation } from '../electron/dictation';
import { AppUpdates } from '../electron/updater';
import type { WriteResult } from '../electron/windows-input';
import { Capture, stableDraftPrefix } from '../src/audio/capture';

function setup(capture: (shortcut?: string) => Promise<boolean> = async () => true) {
  const writes: [string, boolean][] = [], clipboard: string[] = [], calls: string[] = [];
  let answer: WriteResult | Promise<WriteResult> = 'written';
  const controller = new Dictation(
    { begin: id => { calls.push(id); }, transcribe: async () => '测试', end: id => { calls.push(id); } },
    { capture, clear() {}, async insert(text, original) { writes.push([text, original]); return answer; } },
    () => {}, text => clipboard.push(text),
  );
  return { controller, writes, clipboard, calls, next: (result: WriteResult | Promise<WriteResult>) => { answer = result; } };
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

test('short dictation stops after two minutes of recording and finishes normally', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { controller, writes } = setup();
  controller.toggle();
  const id = controller.snapshot().sessionId!;
  t.mock.timers.tick(120_000);
  assert.equal(controller.snapshot().phase, 'preparing');

  controller.recording(id);
  t.mock.timers.tick(119_999);
  assert.equal(controller.snapshot().phase, 'recording');
  t.mock.timers.tick(1);
  assert.equal(controller.snapshot().phase, 'finishing');

  await controller.complete(id, '到达听写时长上限。');
  assert.deepEqual(writes, [['到达听写时长上限。', true]]);
  assert.equal(controller.snapshot().phase, 'idle');
});

test('draft confirmation keeps a Chinese prefix and waits for whole words and numbers', () => {
  assert.equal(stableDraftPrefix('', '今天我们讨论录音'), '');
  assert.equal(stableDraftPrefix('今天', '今天我们'), '今天');
  assert.equal(stableDraftPrefix('今天我们讨论录音', '今天我们讨论设置'), '今天我们讨论');
  assert.equal(stableDraftPrefix('请把 OnoSan 发给', '请把 OnoSau 明天'), '请把');
  assert.equal(stableDraftPrefix('请用 EchoBuddy 写入', '请用 EchoBuddy 打开设置'), '请用 EchoBuddy');
  assert.equal(stableDraftPrefix('金额是 12,345.67 元', '金额是 12,345.68 元'), '金额是');
});

test('continuous speech publishes two batches before a pause or stop', async t => {
  const progress: string[] = [];
  const capture = new Capture('session', {
    level() {}, words() {}, ended() {}, progress: lines => progress.push(lines.join('')),
  });
  const audio = capture as unknown as {
    accept(frame: Float32Array): void;
    recognize(frames: Float32Array[], length: number): Promise<string>;
  };
  const recognize = t.mock.method(audio, 'recognize', async (_frames: Float32Array[], length: number) =>
    length < 16000 ? '今天' : length < 32000 ? '今天我们' : '今天我们测试');
  const voiced = new Float32Array(1024).fill(0.1);
  async function speak(frames: number) {
    for (let i = 0; i < frames; i++) {
      audio.accept(voiced);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  await speak(22);
  assert.deepEqual(progress, ['今天']);
  await speak(11);
  assert.deepEqual(progress, ['今天', '今天我们']);
  assert.equal(recognize.mock.callCount(), 3);
  assert.deepEqual(capture.confirmed(), []);
});

test('streaming writes batches during recording and appends only the final remainder', async () => {
  const { controller, writes } = setup();
  controller.toggle(undefined, 'streaming');
  const id = controller.snapshot().sessionId!;
  controller.recording(id);
  await controller.writeProgress(id, '今天我们');
  await Promise.all([controller.writeProgress(id, '今天我们测试'), controller.writeProgress(id, '今天我们测试')]);
  assert.deepEqual(writes, [['今天我们', true], ['测试', true]]);

  controller.toggle();
  await controller.complete(id, '今天我们测试流式输入。');
  assert.deepEqual(writes, [['今天我们', true], ['测试', true], ['流式输入。', true]]);
  assert.equal(controller.snapshot().pending, '');
});

test('stopping waits for an in-flight streaming write before deciding the final suffix', async () => {
  const { controller, writes, next } = setup();
  let finished!: (result: WriteResult) => void;
  next(new Promise(resolve => { finished = resolve; }));
  controller.toggle(undefined, 'streaming');
  const id = controller.snapshot().sessionId!;
  controller.recording(id);
  const writing = controller.writeProgress(id, '确认的开头');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(writes, [['确认的开头', true]]);

  controller.toggle();
  const completing = controller.complete(id, '确认的开头和结尾。');
  next('written');
  finished('written');
  await Promise.all([writing, completing]);
  assert.deepEqual(writes, [['确认的开头', true], ['和结尾。', true]]);
});

test('streaming stops writing after the caret moves and retains the unwritten suffix', async () => {
  const { controller, writes, next } = setup();
  controller.toggle(undefined, 'streaming');
  const id = controller.snapshot().sessionId!;
  controller.recording(id);
  await controller.writeProgress(id, '第一段。');
  next('moved');
  await controller.writeProgress(id, '第一段。第二段。');
  await controller.writeProgress(id, '第一段。第二段。第三段。');
  await controller.complete(id, '第一段。第二段。第三段。');

  assert.deepEqual(writes, [['第一段。', true], ['第二段。', true]]);
  assert.equal(controller.snapshot().pending, '第二段。第三段。');
});

test('an inconsistent streaming final is retained in full for review', async () => {
  const { controller, writes } = setup();
  controller.toggle(undefined, 'streaming');
  const id = controller.snapshot().sessionId!;
  controller.recording(id);
  await controller.writeProgress(id, '发给小王');
  await controller.complete(id, '发给小黄确认。');
  assert.deepEqual(writes, [['发给小王', true]]);
  assert.equal(controller.snapshot().pending, '发给小黄确认。');
});

test('a partial streaming write keeps the full transcript and pauses further insertion', async () => {
  const { controller, writes, next } = setup();
  controller.toggle(undefined, 'streaming');
  const id = controller.snapshot().sessionId!;
  controller.recording(id);
  await controller.writeProgress(id, '一段。');
  next('partial');
  await controller.writeProgress(id, '一段。二段。');
  await controller.complete(id, '一段。二段。三段。');
  assert.deepEqual(writes, [['一段。', true], ['二段。', true]]);
  assert.equal(controller.snapshot().pending, '一段。二段。三段。');
  assert.match(controller.snapshot().message, /可能已写入部分内容/);
});

test('moved target leaves a recoverable transcript and blocks update installation', async () => {
  const { controller, writes, clipboard, next } = setup();
  controller.toggle();
  const id = controller.snapshot().sessionId!;
  next('moved');
  await controller.complete(id, '保留这句话。');
  assert.equal(controller.snapshot().pending, '保留这句话。');
  assert.equal(controller.blocksInstall(), true);
  await controller.insertPending();
  assert.deepEqual(writes, [['保留这句话。', true], ['保留这句话。', false]]);
  assert.equal(controller.snapshot().pending, '保留这句话。');
  controller.copyPending();
  assert.deepEqual(clipboard, ['保留这句话。']);
  assert.equal(controller.blocksInstall(), false);
});

test('starting another recording discards the previous pending transcript', async () => {
  const { controller, writes, next } = setup();
  controller.toggle();
  const previous = controller.snapshot().sessionId!;
  next('moved');
  await controller.complete(previous, '上一次的转写。');
  assert.equal(controller.snapshot().pending, '上一次的转写。');

  controller.toggle();
  const { sessionId, phase, pending, message } = controller.snapshot();
  assert.equal(phase, 'preparing');
  assert.ok(sessionId && sessionId !== previous);
  assert.equal(pending, '');
  assert.equal(message, '');
  await controller.complete(previous, '迟到的旧转写。');
  assert.equal(controller.snapshot().sessionId, sessionId);

  next('written');
  await controller.complete(sessionId, '新录音的转写。');
  assert.deepEqual(writes, [['上一次的转写。', true], ['新录音的转写。', true]]);
  assert.equal(controller.snapshot().pending, '');
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
