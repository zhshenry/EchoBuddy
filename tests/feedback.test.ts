import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeedbackService, FEEDBACK_ORIGIN } from '../electron/feedback-service';
import { feedbackStatus, feedbackEvents } from '../shared/feedback';

function fixture(t: { after(fn: () => void): void }, request: typeof fetch, product: 'onosan_workbench' | 'cmo_workbench' | 'echobuddy' = 'onosan_workbench') {
  const directory = mkdtempSync(join(tmpdir(), 'feedback-client-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, service: new FeedbackService(directory, product, '1.2.3', request) };
}
test('preview redacts diagnostics and description before saving, copying or sending; every product identifies itself', t => {
  for (const product of ['onosan_workbench', 'cmo_workbench', 'echobuddy'] as const) {
    const { service } = fixture(t, async () => { throw new Error('must not send during preview'); }, product);
    service.record({ stage: 'submit', selectedItemIds: ['private-A'], targetId: 'private-B', itemId: 'private-A' });
    const record = service.prepare('password=secret-value\nC:\\Users\\henry\\private.txt\nme@example.com', 'settings-about');
    const value = service.payload(record.payload.feedbackId);
    for (const secret of ['secret-value', 'henry', 'me@example.com', 'private-A', 'private-B']) assert.ok(!value.includes(secret));
    assert.equal(record.payload.product, product);
    assert.equal(record.status, 'local');
    assert.equal(service.list().length, 1);
    assert.deepEqual(feedbackEvents([{ selectedItemIds: ['A'], targetId: 'B', itemId: 'A' }])[0], { selectedItemIds: ['item-1'], targetId: 'item-2', itemId: 'item-1' });
  }
});
test('unknown POST outcome survives restart; retry checks the same id and never blindly creates a new report', async t => {
  let posts = 0;
  const f = fixture(t, async (url, options) => {
    assert.equal(url, FEEDBACK_ORIGIN + '/api/feedback'); assert.equal(options?.method, 'POST'); posts++;
    throw new Error('response lost');
  });
  const record = f.service.prepare('合成测试', 'settings-about');
  assert.ok((await f.service.send(record.payload.feedbackId)).error);
  const restarted = new FeedbackService(f.directory, 'onosan_workbench', '1.2.3', async url => {
    assert.equal(url, FEEDBACK_ORIGIN + '/api/feedback/' + record.payload.feedbackId);
    return Response.json({ feedbackId: record.payload.feedbackId, status: 'submitted' });
  });
  assert.equal((await restarted.send(record.payload.feedbackId)).status, 'submitted');
  assert.equal(posts, 1);
});
test('concurrent sends share one delivery and an unavailable status check does not trigger another POST', async t => {
  let posts = 0;
  const { service } = fixture(t, async (_url, options) => {
    if (options?.method === 'POST') { posts++; await new Promise(resolve => setTimeout(resolve, 10)); return Response.json({ feedbackId: id, status: 'pending' }, { status: 202 }); }
    throw new Error('offline');
  });
  const id = service.prepare('合成测试', 'test').payload.feedbackId;
  await Promise.all([service.send(id), service.send(id)]);
  await service.send(id);
  assert.equal(posts, 1);
});
test('malformed receipts cannot mark a report sent; progress needs an explicit fixed version', async t => {
  const { service } = fixture(t, async () => new Response('not json', { status: 200 }));
  const record = service.prepare('合成测试', 'test');
  const result = await service.send(record.payload.feedbackId);
  assert.equal(result.status, 'pending'); assert.ok(result.error);
  assert.equal(feedbackStatus({ ...record, status: 'submitted' }), '已提交，待处理');
  assert.equal(feedbackStatus({ ...record, status: 'submitted', progress: 'resolved' }), '已提交，待处理');
  assert.equal(feedbackStatus({ ...record, status: 'submitted', progress: 'resolved', fixVersion: 'v3.1.1' }), '已解决 · v3.1.1');
});
test('large diagnostic metadata is bounded before the user previews the exact upload', t => {
  const { service } = fixture(t, async () => { throw new Error('preview must not send'); });
  for (let index = 0; index < 100; index++) service.record({ stage: '测'.repeat(160), tool: '测'.repeat(160), errorCode: '测'.repeat(160), messageId: '测'.repeat(160) });
  const report = service.prepare('说明'.repeat(2000), 'test');
  assert.ok(report.payload.diagnostics.events.length < 100);
  assert.ok(Buffer.byteLength(service.payload(report.payload.feedbackId), 'utf8') < 65536);
});
