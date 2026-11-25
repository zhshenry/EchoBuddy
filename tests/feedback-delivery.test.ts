import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeedbackNetwork, COMPANY_PROBE, FEEDBACK_MAINTAINER } from '../electron/feedback-network';
import { FeedbackWelink } from '../electron/feedback-welink';
import { FeedbackService, FEEDBACK_ORIGIN } from '../electron/feedback-service';
import { feedbackStatus, feedbackSummary, feedbackMessageParts } from '../shared/feedback';
import { WindowsInput } from '../electron/windows-input';
import { Dictation } from '../electron/dictation';

function directory(t: { after(fn: () => void): void }) {
  const path = mkdtempSync(join(tmpdir(), 'feedback-delivery-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
const noCloud = async () => { throw new Error('intranet must not upload feedback'); };

test('auto routing gives confirmed company access priority; manual choice persists and overrides detection', async t => {
  const path = directory(t);
  const network = new FeedbackNetwork(path, async url => url === COMPANY_PROBE
    ? Response.json({ code: 0, data: { records: [] } }) : Response.json({ ok: true }), () => true);
  const delivery = await network.read();
  assert.equal(delivery.channel, 'welink'); assert.equal(delivery.receiver, 'z00545972');
  assert.equal(delivery.online, true); assert.equal(delivery.cliAvailable, true);
  assert.equal(network.setMode('online').channel, 'online');
  assert.equal((await new FeedbackNetwork(path, noCloud).read()).channel, 'online');
  assert.equal(network.setMode('intranet').channel, 'welink');
  assert.equal(network.setMode('auto').channel, 'welink');
  assert.throws(() => network.setMode({ mode: 'online' }));
});
test('login HTML, proxy errors and malformed OpenX responses do not prove company access', async t => {
  for (const response of [new Response('<html>login</html>'), Response.json({ code: 1, data: { records: [] } }), Response.json({ code: 0, data: {} }), new Response('proxy', { status: 502 })]) {
    const network = new FeedbackNetwork(directory(t), async url => url === COMPANY_PROBE ? response : Response.json({ ok: true }));
    const delivery = await network.read();
    assert.equal(delivery.company, false); assert.equal(delivery.channel, 'online');
  }
  const offline = new FeedbackNetwork(directory(t), noCloud);
  assert.equal((await offline.read()).channel, 'unavailable');
  assert.equal(offline.setMode('intranet').channel, 'welink');
});
test('network probes are deduplicated, expire after ten minutes, and recheck on topology change or explicit request', async t => {
  let requests = 0, time = Date.now(), key = 'wifi';
  const network = new FeedbackNetwork(directory(t), async () => { requests++; return Response.json({ ok: true }); }, () => false, () => time, () => key);
  await Promise.all([network.read(), network.read()]); assert.equal(requests, 2);
  await network.read(); assert.equal(requests, 2);
  time += 600000; await network.read(); assert.equal(requests, 4);
  key = 'vpn'; await network.read(); assert.equal(requests, 6);
  await network.read(true); assert.equal(requests, 8);
});
test('a late probe cannot restore stale topology or undo a manual mode choice', async t => {
  const waits: ((value: Response) => void)[] = [];
  let key = 'old';
  const network = new FeedbackNetwork(directory(t), () => new Promise(resolve => waits.push(resolve)), () => false, Date.now, () => key);
  const old = network.read(); key = 'new'; const fresh = network.read();
  network.setMode('intranet');
  waits[2](Response.json({ code: 0, data: { records: [] } })); waits[3](Response.json({ ok: true }));
  await fresh;
  waits[0](Response.json({})); waits[1](Response.json({ ok: false })); await old;
  const result = await network.read(); assert.equal(result.company, true); assert.equal(result.mode, 'intranet');
});
test('missing CLI and missing login stop before sending; credentials never enter user errors', async () => {
  let calls = 0;
  const absent = new FeedbackWelink(() => undefined, async () => { calls++; throw new Error('never run'); });
  assert.match((await absent.check())!, /未找到/); assert.equal(calls, 0);
  const loggedOut = new FeedbackWelink(() => 'fake.exe', async (_exe, args) => {
    assert.deepEqual(args, ['auth', 'status']); calls++;
    return { code: 1, stdout: 'User Token: secret-private-value', stderr: 'secret' };
  });
  assert.match((await loggedOut.check())!, /尚未登录/); assert.equal(calls, 1);
  const ready = new FeedbackWelink(() => 'fake.exe', async () => ({ code: 0, stdout: 'UID: 123\nUser Token: valid (expires in 3h)', stderr: '' }));
  assert.equal(await ready.check(), undefined);
});
test('WeLink needs an explicit success receipt and never executes a shell command', async () => {
  for (const [stdout, expected] of [[JSON.stringify({ code: 0 }), 'sent'], [JSON.stringify({ resultCode: '200' }), 'sent'], [JSON.stringify({ success: true }), 'sent'], [JSON.stringify({ code: 403, message: 'private' }), 'failed'], ['{}', 'unknown'], ['<html>', 'unknown']] as const) {
    const client = new FeedbackWelink(() => 'fake.exe', async (exe, args) => {
      assert.equal(exe, 'fake.exe');
      assert.deepEqual(args, ['im', 'send-to-user', '--receiver', FEEDBACK_MAINTAINER, '--text', 'text $() & "test"']);
      return { code: 0, stdout, stderr: '' };
    });
    assert.equal((await client.send(FEEDBACK_MAINTAINER, 'text $() & "test"')).state, expected);
  }
  const timedOut = new FeedbackWelink(() => 'fake.exe', async () => { throw new Error('timeout with secret'); });
  assert.deepEqual(await timedOut.send(FEEDBACK_MAINTAINER, 'test'), { state: 'unknown', sentParts: 0, totalParts: 1 });
});
test('intranet saves the original sanitized package before sending exactly the previewed summary', async t => {
  const path = directory(t), service = new FeedbackService(path, 'echobuddy', '0.2.7', noCloud);
  const record = service.prepare('password=private-value\n测试问题', 'settings-feedback');
  const id = record.payload.feedbackId, downloads = join(path, 'downloads');
  const expected = service.payload(id); let sends = 0;
  const client = { check: async () => undefined, send: async (receiver: string, summary: string) => {
    sends++; assert.equal(receiver, 'z00545972');
    assert.equal(summary, feedbackSummary(record.payload, receiver)); assert.ok(!summary.includes('private-value'));
    assert.deepEqual(JSON.parse(readFileSync(join(downloads, `echobuddy-feedback-${id}.json`), 'utf8')), JSON.parse(expected));
    return { state: 'sent' as const };
  } };
  const [sent, duplicate] = await Promise.all([service.handoff(id, downloads, FEEDBACK_MAINTAINER, client), service.handoff(id, downloads, FEEDBACK_MAINTAINER, client)]);
  assert.equal(sent.handoff?.state, 'sent'); assert.deepEqual(sent, duplicate); assert.equal(sends, 1);
  assert.equal(sent.status, 'local'); assert.equal(feedbackStatus(sent), '摘要已发送，反馈包待转交');
  assert.equal(service.payload(id), expected);
  const restarted = new FeedbackService(path, 'echobuddy', '0.2.7', noCloud);
  await restarted.handoff(id, downloads, FEEDBACK_MAINTAINER, client); assert.equal(sends, 1);
});
test('auth failure keeps a local package and can retry; lost receipts or process interruption never repeat IM automatically', async t => {
  const path = directory(t), service = new FeedbackService(path, 'echobuddy', 'test', noCloud), downloads = join(path, 'downloads');
  const id = service.prepare('测试', 'test').payload.feedbackId;
  let checks = 0, sends = 0;
  const client = { check: async () => ++checks === 1 ? '请登录' : undefined, send: async () => { sends++; return { state: 'unknown' as const }; } };
  assert.equal((await service.handoff(id, downloads, FEEDBACK_MAINTAINER, client)).handoff?.state, 'saved'); assert.equal(sends, 0);
  assert.equal((await service.handoff(id, downloads, FEEDBACK_MAINTAINER, client)).handoff?.state, 'unconfirmed'); assert.equal(sends, 1);
  await service.handoff(id, downloads, FEEDBACK_MAINTAINER, client); assert.equal(sends, 1);
  const records = service.list(); records[0].handoff!.state = 'sending';
  writeFileSync(join(path, 'feedback-history.json'), JSON.stringify(records));
  const restarted = new FeedbackService(path, 'echobuddy', 'test', noCloud);
  await restarted.handoff(id, downloads, FEEDBACK_MAINTAINER, client); assert.equal(sends, 1);
});
test('saving for manual WeLink delivery never marks sent; later cloud import can be queried under the same id', async t => {
  const path = directory(t); let id = '', offline = false;
  const service = new FeedbackService(path, 'echobuddy', 'test', async (url, init) => {
    assert.ok(String(url).endsWith(id)); assert.notEqual(init?.method, 'POST');
    if (offline) throw new Error('offline');
    return Response.json({ feedbackId: id, status: 'submitted', progress: 'in-progress' });
  });
  id = service.prepare('测试', 'test').payload.feedbackId;
  const saved = await service.savePackage(id, join(path, 'downloads'), FEEDBACK_MAINTAINER);
  assert.equal(saved.status, 'local'); assert.equal(feedbackStatus(saved), '反馈包已保存，待转交');
  assert.equal(feedbackStatus(await service.refresh(id)), '处理中');
  offline = true;
  const last = await service.refresh(id);
  assert.equal(feedbackStatus(last), '处理中'); assert.match(last.error!, /无法查询处理状态/);
});
test('a feedback package does not include network probe addresses', t => {
  const service = new FeedbackService(directory(t), 'echobuddy', '0.2.8', noCloud);
  const record = service.prepare('合成测试', 'settings-feedback');
  const payload = service.payload(record.payload.feedbackId);
  assert.equal(payload.includes(new URL(COMPANY_PROBE).host), false);
  assert.equal(payload.includes(new URL(FEEDBACK_ORIGIN).host), false);
  assert.equal(payload.includes('/health'), false);
});
test('a long summary stays in two bounded IMs while preserving feedback id, recipient and original package', t => {
  const service = new FeedbackService(directory(t), 'echobuddy', 'test', noCloud);
  const record = service.prepare('😀'.repeat(1900), 'test');
  const summary = feedbackSummary(record.payload, FEEDBACK_MAINTAINER);
  assert.ok(summary.length <= 2800);
  const parts = feedbackMessageParts(summary);
  assert.equal(parts.length, 2);
  assert.ok(parts.every(part => part.length <= 1450 && Buffer.from(part, 'utf8').toString('utf8') === part));
  assert.equal(parts.map(part => part.slice(5)).join(''), summary);
  assert.ok(summary.includes(record.payload.feedbackId)); assert.ok(summary.includes('z00545972'));
  assert.equal(record.payload.description.length, 3800);
});
test('summary prefers recent distinct failures over routine events, preserves description and sanitizes diagnostics before preview', t => {
  const service = new FeedbackService(directory(t), 'echobuddy', 'test', noCloud);
  service.record({ stage: 'input:insert', status: 'paste-unconfirmed' });
  service.record({ stage: 'speech:transcribe', status: 'failed', errorCode: 'password=private-diagnostic' });
  service.record({ stage: 'input:current', status: 'written' });
  service.record({ stage: 'input:current', status: 'written' });
  service.record({ stage: 'message-round', status: 'completed' });
  service.record({ stage: 'child-process', status: 'killed', errorCode: '0' });
  const record = service.prepare('我点了补写，但自动写入没有生效。', 'settings-feedback');
  const frozen = service.payload(record.payload.feedbackId);
  service.record({ stage: 'speech:transcribe', status: 'failed', errorCode: 'LATER_ERROR_MUST_NOT_APPEAR' });
  const summary = feedbackSummary(record.payload, FEEDBACK_MAINTAINER);
  assert.match(summary, /我点了补写/);
  assert.match(summary, /最近异常/); assert.match(summary, /自动写入 · 粘贴结果未确认/);
  assert.match(summary, /语音识别 · 失败/); assert.match(summary, /关键操作/);
  assert.equal(summary.match(/写入当前光标/g)?.length, 1);
  assert.ok(summary.indexOf('语音识别 · 失败') < summary.indexOf('自动写入 · 粘贴结果未确认'));
  for (const value of ['private-diagnostic', 'message-round', '后台进程', 'LATER_ERROR_MUST_NOT_APPEAR']) assert.ok(!summary.includes(value));
  assert.equal(service.payload(record.payload.feedbackId), frozen);
});
test('a long description leaves room for recent failures and still respects every message limit', t => {
  const service = new FeedbackService(directory(t), 'echobuddy', 'test', noCloud);
  for (let i = 0; i < 20; i++) service.record({ stage: 'input:insert', status: 'paste-unconfirmed', errorCode: String(i) });
  const record = service.prepare('😀'.repeat(1900), 'test');
  const summary = feedbackSummary(record.payload, FEEDBACK_MAINTAINER);
  assert.match(summary, /最近异常/); assert.ok(summary.length <= 2800);
  assert.ok(feedbackMessageParts(summary).every(part => part.length <= 1450 && Buffer.from(part, 'utf8').toString('utf8') === part));
  const legacy = { ...record.payload, diagnostics: { ...record.payload.diagnostics, events: [] } };
  assert.ok(!feedbackSummary(legacy, FEEDBACK_MAINTAINER).includes('最近异常'));
});
test('split delivery sends exactly previewed numbered parts and partial failures cannot repeat the first message after restart', async t => {
  for (const second of ['failed', 'unknown', 'sent'] as const) {
    const path = directory(t), service = new FeedbackService(path, 'echobuddy', 'test', noCloud);
    const record = service.prepare('用于分段发送的描述。'.repeat(200), 'test'), id = record.payload.feedbackId;
    const sent: string[] = [];
    const client = new FeedbackWelink(() => 'fake.exe', async (_exe, args) => {
      if (args[0] === 'auth') return { code: 0, stdout: 'Status: authenticated', stderr: '' };
      sent.push(args.at(-1)!);
      if (sent.length === 2 && second === 'unknown') throw new Error('response lost');
      return { code: 0, stdout: JSON.stringify({ code: sent.length === 2 && second === 'failed' ? 403 : 0 }), stderr: '' };
    });
    const result = await service.handoff(id, join(path, 'downloads'), FEEDBACK_MAINTAINER, client);
    assert.deepEqual(sent, feedbackMessageParts(feedbackSummary(record.payload, FEEDBACK_MAINTAINER)));
    assert.equal(result.handoff?.state, second === 'sent' ? 'sent' : 'unconfirmed');
    assert.equal(result.handoff?.sentParts, second === 'sent' ? 2 : 1); assert.equal(result.handoff?.totalParts, 2);
    if (second !== 'sent') { assert.match(result.handoff!.error!, /已确认发送 1\/2/); assert.match(feedbackStatus(result), /1\/2/); }
    const restarted = new FeedbackService(path, 'echobuddy', 'test', noCloud);
    await restarted.handoff(id, join(path, 'downloads'), FEEDBACK_MAINTAINER, client);
    assert.equal(sent.length, 2);
  }
});
test('input outcomes and dictation lifecycle enter diagnostics without recording transcript or clipboard content', async t => {
  const service = new FeedbackService(directory(t), 'echobuddy', 'test', noCloud), input = new WindowsInput('unused');
  const responses = ['paste-on-stop', 'paste-unconfirmed', 'written'];
  (input as unknown as { ask(command: string): Promise<string> }).ask = async () => responses.shift()!;
  assert.equal(await input.capture(), 'paste-on-stop');
  assert.equal(await input.insert('private-transcript-text', true), 'paste-unconfirmed');
  assert.equal(await input.insert('private-transcript-text', false), 'written');
  const dictation = new Dictation({ begin() {}, end() {}, transcribe: async () => '' },
    { capture: async () => 'captured', insert: async () => 'written', clear() {} }, () => {}, () => {});
  dictation.toggle(); const id = dictation.snapshot().sessionId!;
  dictation.recording(id); dictation.toggle(); await dictation.complete(id, 'private-transcript-text');
  const record = service.prepare('测试写入诊断', 'test'), json = service.payload(record.payload.feedbackId);
  for (const stage of ['input:capture', 'input:insert', 'input:current', 'dictation:start', 'dictation:stop', 'dictation:complete'])
    assert.ok(record.payload.diagnostics.events.some(event => event.stage === stage), stage);
  assert.ok(!json.includes('private-transcript-text'));
  assert.match(feedbackSummary(record.payload, FEEDBACK_MAINTAINER), /粘贴结果未确认/);
});
