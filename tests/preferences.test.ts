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
    ...legacy, recordingMode: 'dictation', languages: [...RECOGNITION_LANGUAGES],
  });
});

test('an unavailable recording mode falls back to short dictation and keeps the saved languages', t => {
  const file = testSettings(t);
  const saved = loadPreferences(file);
  saved.recordingMode = 'meeting';
  saved.languages = ['zh', 'en'];
  savePreferences(file, saved);
  const reloaded = loadPreferences(file);
  assert.equal(reloaded.recordingMode, 'dictation');
  assert.deepEqual(reloaded.languages, ['zh', 'en']);

  writeFileSync(file, JSON.stringify({ ...saved, languages: [] }), 'utf8');
  assert.deepEqual(loadPreferences(file).languages, [...RECOGNITION_LANGUAGES]);
});
