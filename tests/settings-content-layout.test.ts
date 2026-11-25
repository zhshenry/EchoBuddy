import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/widget/widget.css', import.meta.url), 'utf8').replace(/\s+/g, ' ');

function rule(selector: string): string {
  const body = css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1];
  assert.ok(body, `missing rule ${selector}`);
  return body;
}

test('settings content reserves a vertical gutter and cannot scroll sideways', () => {
  const body = rule('.settings-content');
  assert.match(body, /min-width:\s*0/);
  assert.match(body, /min-height:\s*0/);
  assert.match(body, /overflow-x:\s*hidden/);
  assert.match(body, /overflow-y:\s*auto/);
  assert.match(body, /scrollbar-gutter:\s*stable/);
  assert.match(body, /overflow-wrap:\s*anywhere/);
  assert.equal(/\soverflow:\s*auto/.test(body), false);
});

test('settings content rows and previews shrink or wrap instead of widening the page', () => {
  const rows = rule('.settings-content :is(.key-button, .keys, .update .row, .hotword-list > li, .hotword-controls, .speaker-heading, .speaker-actions)');
  assert.match(rows, /flex-wrap:\s*wrap/);
  assert.match(rows, /min-width:\s*0/);
  assert.match(rows, /max-width:\s*100%/);

  const controls = rule('.settings-content :is(.update-action, .release-link, .hotword-controls button, .key-button)');
  assert.match(controls, /max-width:\s*100%/);
  assert.match(controls, /white-space:\s*normal/);

  assert.match(rule('.settings-content .figures'), /repeat\(auto-fit,\s*minmax\(32px,\s*1fr\)\)/);
  assert.match(rule('.settings-content .swatches'), /repeat\(auto-fit,\s*minmax\(16px,\s*1fr\)\)/);

  const route = rule('.settings-content .feedback-route-controls');
  assert.match(route, /flex-wrap:\s*wrap/);
  assert.match(route, /min-width:\s*0/);
  assert.match(rule('.settings-content .feedback-route-controls select'), /min-width:\s*min\(112px,\s*100%\)/);
  assert.match(rule('.settings-content .feedback-route-controls select'), /max-width:\s*100%/);

  const actions = rule('.settings-content .feedback-actions');
  assert.match(actions, /min-width:\s*0/);
  assert.match(actions, /max-width:\s*100%/);
  assert.match(rule('.settings-content .feedback-actions button'), /white-space:\s*normal/);
  assert.match(rule('.settings-content .feedback-preview button.feedback-primary'), /min-width:\s*min\(120px,\s*100%\)/);

  const preview = rule('.settings-content .feedback-panel pre');
  assert.match(preview, /min-width:\s*0/);
  assert.match(preview, /max-width:\s*100%/);
  assert.match(preview, /overflow-x:\s*hidden/);
  assert.match(preview, /overflow-y:\s*auto/);
  assert.match(preview, /white-space:\s*pre-wrap/);
  assert.match(preview, /overflow-wrap:\s*anywhere/);
  assert.match(rule('.settings-content .feedback-panel dl > div'), /flex-wrap:\s*wrap/);
  assert.match(rule('.settings-content .feedback-panel dd'), /overflow-wrap:\s*anywhere/);
});

test('feedback network capsules wrap inside the settings content width', () => {
  const network = rule('.settings-content .feedback-network');
  assert.match(network, /display:\s*flex/);
  assert.match(network, /flex-wrap:\s*wrap/);
  assert.match(network, /min-width:\s*0/);
  assert.match(network, /max-width:\s*100%/);
  const capsules = rule('.settings-content .feedback-capsules');
  assert.match(capsules, /flex-wrap:\s*wrap/);
  assert.match(capsules, /min-width:\s*0/);
  assert.match(capsules, /max-width:\s*100%/);
  assert.match(rule('.settings-content .feedback-capsule'), /max-width:\s*100%/);
  const note = rule('.settings-content .feedback-network-note');
  assert.match(note, /min-width:\s*0/);
  assert.match(note, /max-width:\s*100%/);
  assert.match(note, /overflow-wrap:\s*anywhere/);
});

test('feedback image attachments wrap inside the settings content width', () => {
  for (const selector of ['.settings-content .feedback-attachments', '.settings-content .feedback-attachment-head', '.settings-content .feedback-thumbs', '.settings-content .feedback-thumb', '.settings-content .feedback-image-note']) {
    const body = rule(selector);
    assert.match(body, /min-width:\s*0/);
    assert.match(body, /max-width:\s*100%/);
  }
  assert.match(rule('.settings-content .feedback-attachment-head'), /flex-wrap:\s*wrap/);
  assert.match(rule('.settings-content .feedback-attachment-head > span'), /overflow-wrap:\s*anywhere/);
  assert.match(rule('.settings-content .feedback-thumbs'), /display:\s*flex/);
  assert.match(rule('.settings-content .feedback-thumbs'), /flex-wrap:\s*wrap/);
  assert.match(rule('.settings-content .feedback-thumb'), /flex:\s*0 1 72px/);
  assert.match(rule('.settings-content .feedback-thumb img'), /max-width:\s*100%/);
  assert.match(rule('.settings-content .feedback-thumb figcaption'), /text-overflow:\s*ellipsis/);
  assert.match(rule('.settings-content .feedback-attachment-files'), /overflow-wrap:\s*anywhere/);
  assert.match(rule('.settings-content .feedback-image-note'), /overflow-wrap:\s*anywhere/);
});

test('narrow settings windows only tighten content padding', () => {
  const narrow = css.match(/@media \(max-width:\s*480px\)\s*\{(.*)\}\s*$/)?.[1] ?? '';
  assert.match(narrow, /\.settings-layout\s*\{[^}]*grid-template-columns:\s*120px minmax\(0,\s*1fr\)/);
  assert.match(narrow, /\.settings-content\s*\{[^}]*padding-right:\s*14px;\s*padding-left:\s*14px/);
});

test('the floating inline settings panel keeps its existing gutter and is not part of this layout change', () => {
  const inline = rule('.inline-settings');
  assert.match(inline, /scrollbar-gutter:\s*stable/);
  assert.equal(/overflow-x/.test(inline), false);
});
