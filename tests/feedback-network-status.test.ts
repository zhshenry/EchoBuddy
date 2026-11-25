import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { feedbackCapsuleState, type FeedbackDelivery } from '../shared/feedback';
import { FeedbackNetworkStatus, FeedbackPanel } from '../src/views/FeedbackPanel';

const delivery = (company: boolean, online: boolean, checkedAt = '2026-11-25T06:21:00.000Z'): Pick<FeedbackDelivery, 'company' | 'online' | 'checkedAt'> =>
  ({ company, online, checkedAt });

function markup(props: { checking: boolean; error?: string; delivery?: Pick<FeedbackDelivery, 'company' | 'online' | 'checkedAt'> }): string {
  return renderToStaticMarkup(createElement(FeedbackNetworkStatus, { checking: props.checking, error: props.error ?? '', delivery: props.delivery }));
}

function capsules(html: string): Array<[string, string]> {
  return [...html.matchAll(/class="feedback-capsule is-(checking|confirmed|unconfirmed)"[^>]*>[\s\S]*?(公司内网|公网)/g)].map(match => [match[2], match[1]]);
}

test('capsule state stays in progress until a check concludes, then follows each probe independently', () => {
  assert.equal(feedbackCapsuleState(true, false, true), 'checking');
  assert.equal(feedbackCapsuleState(true, true, false), 'checking');
  assert.equal(feedbackCapsuleState(false, true, true), 'unconfirmed');
  assert.equal(feedbackCapsuleState(false, false, undefined), 'unconfirmed');
  assert.equal(feedbackCapsuleState(false, false, false), 'unconfirmed');
  assert.equal(feedbackCapsuleState(false, false, true), 'confirmed');
});

test('confirmed, unconfirmed, and in-progress network results render as fixed capsules', () => {
  const both = markup({ checking: false, delivery: delivery(true, true) });
  assert.deepEqual(capsules(both), [['公司内网', 'confirmed'], ['公网', 'confirmed']]);
  assert.match(both, /公司内网已确认，公网已确认/);
  assert.match(both, /· \d{2}:\d{2}/);
  assert.equal(both.includes('已连接公司网络'), false);

  const neither = markup({ checking: false, delivery: delivery(false, false) });
  assert.deepEqual(capsules(neither), [['公司内网', 'unconfirmed'], ['公网', 'unconfirmed']]);
  assert.match(neither, /公司内网未确认，公网未确认/);
  assert.equal(neither.includes('is-confirmed'), false);
  assert.equal(neither.includes('暂未检测到可用通道'), false);

  const onlineOnly = markup({ checking: false, delivery: delivery(false, true) });
  assert.deepEqual(capsules(onlineOnly), [['公司内网', 'unconfirmed'], ['公网', 'confirmed']]);
  assert.match(onlineOnly, /公司内网未确认，公网已确认/);
  assert.equal(onlineOnly.includes('公司网络未确认，在线反馈可用'), false);

  const checking = markup({ checking: true, delivery: delivery(true, true) });
  assert.deepEqual(capsules(checking), [['公司内网', 'checking'], ['公网', 'checking']]);
  assert.match(checking, /正在检测公司网络和在线反馈服务/);
  assert.match(checking, /检测中…/);
  assert.match(checking, /aria-busy="true"/);
  assert.equal(checking.includes('is-confirmed'), false);
  assert.equal(checking.includes('· '), false);

  const failed = markup({ checking: false, error: '无法检测反馈通道，可重新检测或手动选择。', delivery: delivery(true, true) });
  assert.deepEqual(capsules(failed), [['公司内网', 'unconfirmed'], ['公网', 'unconfirmed']]);
  assert.match(failed, /无法检测反馈通道，可重新检测或手动选择。/);
  assert.equal(failed.includes('is-confirmed'), false);
  assert.equal(failed.includes('aria-busy'), false);

  const pending = markup({ checking: false });
  assert.deepEqual(capsules(pending), [['公司内网', 'unconfirmed'], ['公网', 'unconfirmed']]);
  assert.match(pending, /尚未检测反馈通道/);
  assert.match(pending, /尚未检测/);
});

test('the feedback page shows capsules under the method controls and keeps the current channel explanation', () => {
  const html = renderToStaticMarkup(createElement(FeedbackPanel, {
    api: {
      prepare: async () => { throw new Error('unused'); },
      list: async () => [],
      delivery: async () => { throw new Error('unused'); },
      setMode: async () => { throw new Error('unused'); },
      send: async () => { throw new Error('unused'); },
      refresh: async () => { throw new Error('unused'); },
      export: async () => false,
      copy: async () => {},
      copyWelink: async () => { throw new Error('unused'); },
    },
    product: 'EchoBuddy',
    context: 'settings-feedback',
  }));
  const route = html.slice(html.indexOf('feedback-routing'), html.indexOf('feedback-compose-footer'));
  const controls = route.indexOf('feedback-route-controls');
  const network = route.indexOf('feedback-network');
  const location = route.indexOf('反馈会保存在本机');
  assert.ok(controls >= 0 && network > controls && location > network);
  assert.deepEqual(capsules(route), [['公司内网', 'checking'], ['公网', 'checking']]);
  assert.match(route, /检测中…/);
  assert.match(route, /自动选择/);
  assert.equal(route.includes('已连接公司网络'), false);
  assert.equal(route.includes('openx.huawei.com'), false);
  assert.equal(html.includes('/health'), false);

  const source = readFileSync(new URL('../src/views/FeedbackPanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /发送位置：在线反馈服务。提交后可查询处理状态。/);
  assert.match(source, /发送位置：WeLink 维护人/);
  assert.match(source, /反馈会保存在本机。你可以手动选择反馈方式，或保存反馈包。/);
  assert.equal(source.includes('已连接公司网络'), false);
  assert.equal(source.includes('公司网络未确认，在线反馈可用'), false);
  assert.equal(source.includes('暂未检测到可用通道'), false);
});
