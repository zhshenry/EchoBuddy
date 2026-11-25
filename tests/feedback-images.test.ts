import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { inflateSync } from 'node:zlib';
import { FeedbackService, FEEDBACK_ORIGIN } from '../electron/feedback-service';
import { bmpToPng } from '../electron/feedback-files';
import { feedbackSummary, type FeedbackBridge } from '../shared/feedback';
import {
  describeFeedbackImage, feedbackClipboardImages, feedbackImageBytes, feedbackImageTransportNote,
  feedbackOnlineImageNote, removeFeedbackImage, takeFeedbackImages,
} from '../shared/feedback-images';
import { FeedbackAttachmentSection, FeedbackPanel } from '../src/views/FeedbackPanel';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const webp = Buffer.alloc(12);
webp.write('RIFF', 0); webp.writeUInt32LE(4, 4); webp.write('WEBP', 8);

function directory(t: { after(fn: () => void): void }) {
  const path = mkdtempSync(join(tmpdir(), 'feedback-images-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function bmp24(width: number, height: number, color: [number, number, number]): Buffer {
  const stride = Math.ceil(width * 3 / 4) * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (height - 1 - y) * stride + x * 3;
    pixels[index] = color[2]; pixels[index + 1] = color[1]; pixels[index + 2] = color[0];
  }
  const header = Buffer.alloc(54);
  header.write('BM', 0);
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  return Buffer.concat([header, pixels]);
}
function unzip(data: Buffer, path: string): string[] {
  const zip = join(path, 'package.zip');
  const out = join(path, 'unpacked');
  writeFileSync(zip, data);
  const result = spawnSync('python3', ['-c', `
import pathlib, sys, zipfile
archive, folder = sys.argv[1:]
with zipfile.ZipFile(archive) as package:
    assert package.testzip() is None, package.testzip()
    package.extractall(folder)
    print('\\n'.join(package.namelist()))
`, zip, out], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n');
}

test('adding, pasting and deleting images keeps explicit limit errors', () => {
  const added = takeFeedbackImages([], [{ key: 'shot', name: '截图 1.png', source: 'file', data: png }]);
  assert.equal(added.error, '');
  assert.equal(added.images[0].name, '01-截图-1.png');
  assert.equal(added.images[0].label, '截图 1');
  assert.equal(added.images[0].type, 'image/png');
  const pasted = takeFeedbackImages(added.images, [
    { key: 'one', name: '', source: 'paste', data: png },
    { key: 'two', name: 'image.png', source: 'paste', data: gif },
  ]);
  assert.equal(pasted.error, '');
  assert.deepEqual(pasted.images.map(item => [item.label, item.name]), [
    ['截图 1', '01-截图-1.png'],
    ['粘贴的图片', '02-pasted.png'],
    ['粘贴的图片 2', '03-pasted.gif'],
  ]);
  const removed = removeFeedbackImage(pasted.images, 'one');
  assert.deepEqual(removed.map(item => item.name), ['01-截图-1.png', '02-pasted.gif']);
  assert.equal(removed[1].label, '粘贴的图片');
  const rejected = takeFeedbackImages(removed, [
    { name: 'notes.txt', source: 'file', data: Uint8Array.from([1, 2, 3, 4]) },
    { name: 'empty.png', source: 'file', data: new Uint8Array() },
    { name: 'clip.bmp', source: 'paste', data: bmp24(1, 1, [1, 2, 3]) },
    { name: 'photo.bmp', source: 'file', data: bmp24(1, 1, [1, 2, 3]) },
    { name: 'huge.png', source: 'file', data: new Uint8Array(feedbackImageBytes + 1) },
  ]);
  assert.equal(rejected.images.length, 2);
  assert.match(rejected.error, /「notes\.txt」不是 PNG、JPEG、WebP 或 GIF，未添加。/);
  assert.match(rejected.error, /「empty\.png」是空文件，未添加。/);
  assert.match(rejected.error, /无法把剪贴板图片保存为 PNG，「clip\.bmp」未添加。/);
  assert.match(rejected.error, /「photo\.bmp」不是 PNG、JPEG、WebP 或 GIF，未添加。/);
  assert.match(rejected.error, /「huge\.png」超过 5 MB，未添加。/);
  const full = takeFeedbackImages([], Array.from({ length: 6 }, (_, index) => ({ name: `图${index}.png`, source: 'file' as const, data: png })));
  assert.equal(full.images.length, 5);
  assert.match(full.error, /最多 5 张图片，「图5\.png」未添加。/);
  assert.equal(feedbackClipboardImages([{ name: 'a.txt', type: 'text/plain' }], []), null);
  const files = [{ name: 'a.png', type: 'image/png' }];
  const items = [{ name: 'b.png', type: 'image/png' }];
  assert.deepEqual(feedbackClipboardImages(files, items), files);
  assert.deepEqual(feedbackClipboardImages([], items), items);
});

test('a clipboard bitmap is stored as PNG and chosen files keep their image type', t => {
  const path = directory(t);
  const service = new FeedbackService(path, 'echobuddy', '0.2.8', async () => { throw new Error('preview must not send'); });
  const bitmap = bmp24(2, 2, [12, 34, 56]);
  const converted = bmpToPng(bitmap);
  assert.equal(describeFeedbackImage(converted), 'png');
  assert.equal(converted.readUInt32BE(16), 2);
  assert.equal(converted.readUInt32BE(20), 2);
  const raw = inflateSync(converted.subarray(converted.indexOf(Buffer.from('IDAT')) + 4, converted.lastIndexOf(Buffer.from('IEND')) - 8));
  assert.equal(raw[1], 12); assert.equal(raw[2], 34); assert.equal(raw[3], 56); assert.equal(raw[4], 255);
  const record = service.prepare('粘贴了一张位图', 'settings-feedback', [
    { name: '', source: 'paste', data: bitmap },
    { name: 'photo.jpg', source: 'file', data: jpeg },
    { name: 'mark.webp', source: 'file', data: webp },
    { name: 'anim.gif', source: 'file', data: gif },
  ]);
  assert.deepEqual(record.attachments?.map(item => [item.name, item.label]), [
    ['01-pasted.png', '粘贴的图片'], ['02-photo.jpg', 'photo'], ['03-mark.webp', 'mark'], ['04-anim.gif', 'anim'],
  ]);
  assert.equal(record.attachments?.[0].type, 'image/png');
  assert.equal(describeFeedbackImage(service.images(record.payload.feedbackId)[0].data), 'png');
  assert.throws(() => service.prepare('选了 bmp', 'test', [{ name: 'photo.bmp', source: 'file', data: bitmap }]), /不是 PNG、JPEG、WebP 或 GIF/);
  assert.equal(service.list().length, 1);
});

test('the feedback package contains the JSON and image files and history can reopen them', async t => {
  const path = directory(t);
  const service = new FeedbackService(path, 'echobuddy', '0.2.8', async () => { throw new Error('package must not send'); });
  const record = service.prepare('请看附图', 'settings-feedback', [{ name: '截图.png', source: 'file', data: png }]);
  const id = record.payload.feedbackId;
  const history = readFileSync(join(path, 'feedback-history.json'));
  assert.equal(history.includes(png), false);
  assert.equal(JSON.parse(history.toString()).some((item: { attachments?: { data?: unknown }[] }) => item.attachments?.some(image => 'data' in image)), false);
  const file = service.packageFile(id);
  assert.equal(file.name, `echobuddy-feedback-${id}.zip`);
  const names = unzip(file.data, path);
  assert.deepEqual(names.sort(), [`01-截图.png`, `echobuddy-feedback-${id}.json`].sort());
  assert.deepEqual(JSON.parse(readFileSync(join(path, 'unpacked', `echobuddy-feedback-${id}.json`), 'utf8')), JSON.parse(service.payload(id)));
  assert.deepEqual(readFileSync(join(path, 'unpacked', '01-截图.png')), png);
  const saved = await service.savePackage(id, join(path, 'downloads'), 'z00545972');
  assert.equal(saved.handoff?.packagePath, join(path, 'downloads', file.name));
  assert.deepEqual(readFileSync(saved.handoff!.packagePath), file.data);
  const summary = service.summary(id, 'z00545972');
  assert.match(summary, new RegExp(`图片附件 1 张：01-截图\\.png`));
  assert.match(summary, new RegExp(`echobuddy-feedback-${id}\\.zip`));
  assert.equal(summary.includes(png.toString('base64')), false);
  assert.ok(summary.length <= 2800);
  const restarted = new FeedbackService(path, 'echobuddy', '0.2.8', async () => { throw new Error('reopen must not send'); });
  const again = restarted.list()[0];
  assert.equal(again.attachments?.[0].label, '截图');
  assert.deepEqual(restarted.images(id)[0].data, png);
  const plain = service.prepare('没有图片', 'test');
  assert.equal(service.packageFile(plain.payload.feedbackId).name.endsWith('.json'), true);
});

test('the online channel posts JSON only and tells the user that images stay in the package', async t => {
  const path = directory(t);
  let body = '';
  let posts = 0;
  let id = '';
  const service = new FeedbackService(path, 'echobuddy', '0.2.8', async (url, init) => {
    posts++;
    assert.equal(url, FEEDBACK_ORIGIN + '/api/feedback');
    assert.equal(init?.method, 'POST');
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers['Content-Type'], 'application/json');
    body = String(init?.body);
    return Response.json({ feedbackId: id, status: 'submitted' });
  });
  const record = service.prepare('在线只发文字', 'settings-feedback', [{ name: 'shot.png', source: 'file', data: png }]);
  id = record.payload.feedbackId;
  const sent = await service.send(id);
  assert.equal(posts, 1);
  assert.equal(JSON.parse(body).feedbackId, id);
  assert.equal(Object.hasOwn(JSON.parse(body), 'attachments'), false);
  assert.equal(body.includes(png.toString('base64')), false);
  assert.equal(Buffer.byteLength(body), Buffer.byteLength(JSON.stringify(record.payload)));
  assert.equal(sent.status, 'submitted');
  assert.deepEqual(service.images(id)[0].data, png);
  assert.equal(feedbackImageTransportNote('online', 1, true), feedbackOnlineImageNote);
  assert.match(feedbackOnlineImageNote, /当前在线通道只提交文字和诊断，不传送图片/);
  assert.match(feedbackOnlineImageNote, /可改为内网转交，或先保存反馈包/);
  assert.match(feedbackImageTransportNote('online', 1, false), /所选图片会写入反馈包/);
  assert.match(feedbackImageTransportNote('welink', 1, true), /摘要只写附件数量和文件名/);
  assert.equal(feedbackImageTransportNote('online', 0, true), '');
  const summary = feedbackSummary(record.payload, 'z00545972', record.attachments);
  assert.match(summary, /01-shot\.png/);
  assert.equal(summary.includes(png.toString('base64')), false);
});

test('the feedback page shows an empty attachment area, removable thumbnails, errors and the online warning beside the network capsules', () => {
  const html = renderToStaticMarkup(createElement(FeedbackAttachmentSection, {
    canEdit: true,
    images: [
      { key: 'shot', name: '01-截图.png', label: '截图', url: 'data:image/png;base64,aaaa' },
      { key: 'paste', name: '02-pasted.png', label: '粘贴的图片' },
    ],
    error: '最多 5 张图片，「extra.png」未添加。',
    notice: feedbackImageTransportNote('online', 2, true),
  }));
  assert.match(html, /添加图片/);
  assert.match(html, /aria-label="移除截图"/);
  assert.match(html, /aria-label="移除粘贴的图片"/);
  assert.match(html, /01-截图\.png/);
  assert.match(html, /02-pasted\.png/);
  assert.match(html, /最多 5 张图片，「extra\.png」未添加。/);
  assert.match(html, /不传送图片/);
  assert.match(html, /role="alert"/);
  const api: FeedbackBridge = {
    prepare: async () => { throw new Error('unused'); },
    list: async () => [], images: async () => [],
    delivery: async () => { throw new Error('unused'); }, setMode: async () => { throw new Error('unused'); },
    send: async () => { throw new Error('unused'); }, refresh: async () => { throw new Error('unused'); },
    export: async () => false, copy: async () => {}, copyWelink: async () => { throw new Error('unused'); },
  };
  const page = renderToStaticMarkup(createElement(FeedbackPanel, { api, product: 'EchoBuddy', context: 'settings-feedback' }));
  assert.match(page, /图片附件（可选，最多 5 张）/);
  assert.match(page, /添加图片/);
  assert.match(page, /可点击添加，或在此页粘贴图片。图片由你选择后才会附带。/);
  assert.match(page, /不自动读取聊天、记忆、录音或文件。/);
  assert.match(page, /公司内网/);
  assert.match(page, /公网/);
  assert.equal(page.includes('feedback-thumb'), false);
  assert.equal(page.includes('已连接公司网络'), false);
  const route = page.indexOf('feedback-routing');
  const attachments = page.indexOf('feedback-attachments');
  const footer = page.indexOf('feedback-compose-footer');
  assert.ok(attachments >= 0 && attachments < route && route < footer);
});
