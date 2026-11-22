import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { loadPreferences, savePreferences } from '../electron/preferences';
import { RECOGNITION_LANGUAGES } from '../shared/speech-contracts';

function testSettings(t: TestContext) {
  const directory = mkdtempSync(join(process.cwd(), '.echobuddy-settings-'));
  const file = join(directory, 'settings.json');
  t.after(() => {
    rmSync(file, { force: true });
    rmSync(file + '.tmp', { force: true });
    rmdirSync(directory);
  });
  return file;
}

test('legacy settings keep the shortcut, avatar, and overlay position', t => {
  const file = testSettings(t);
  const legacy = { avatar: 'drop:coral', shortcut: 'F8', position: { x: 200, y: 100 } };
  writeFileSync(file, JSON.stringify(legacy), 'utf8');
  assert.deepEqual(loadPreferences(file), {
    ...legacy, recordingMode: 'dictation', writeTiming: 'sentence', dockOnEdge: true, languages: [...RECOGNITION_LANGUAGES],
    meetingSources: ['microphone'],
  });
});

test('dock preference restores a valid saved position and clears a disabled or invalid dock', t => {
  const file = testSettings(t);
  const dock = { side: 'top', displayId: 12, offset: 0.65 } as const;
  const saved = { ...loadPreferences(file), dock };
  savePreferences(file, saved);
  assert.deepEqual(loadPreferences(file).dock, dock);

  savePreferences(file, { ...saved, dockOnEdge: false });
  assert.equal(loadPreferences(file).dockOnEdge, false);
  assert.equal(loadPreferences(file).dock, undefined);

  writeFileSync(file, JSON.stringify({ ...saved, dock: { ...dock, offset: -0.1 } }), 'utf8');
  assert.equal(loadPreferences(file).dock, undefined);
});

test('streaming write timing is saved and unrecognized values use sentence mode', t => {
  const file = testSettings(t);
  const preferences = loadPreferences(file);
  savePreferences(file, { ...preferences, writeTiming: 'streaming' });
  assert.equal(loadPreferences(file).writeTiming, 'streaming');

  writeFileSync(file, JSON.stringify({ ...preferences, writeTiming: 'unknown' }), 'utf8');
  assert.equal(loadPreferences(file).writeTiming, 'sentence');
});

test('meeting mode and selected sources persist, and unknown or empty choices use safe defaults', t => {
  const file = testSettings(t);
  const saved = loadPreferences(file);
  saved.recordingMode = 'meeting';
  saved.meetingSources = ['system'];
  saved.languages = ['zh', 'en'];
  savePreferences(file, saved);
  const reloaded = loadPreferences(file);
  assert.equal(reloaded.recordingMode, 'meeting');
  assert.deepEqual(reloaded.meetingSources, ['system']);
  assert.deepEqual(reloaded.languages, ['zh', 'en']);

  writeFileSync(file, JSON.stringify({ ...saved, recordingMode: 'unknown', languages: [], meetingSources: ['unknown'] }), 'utf8');
  const fallback = loadPreferences(file);
  assert.equal(fallback.recordingMode, 'dictation');
  assert.deepEqual(fallback.meetingSources, ['microphone']);
  assert.deepEqual(fallback.languages, [...RECOGNITION_LANGUAGES]);
});
