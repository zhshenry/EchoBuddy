import assert from 'node:assert/strict';
import test from 'node:test';
import { applyHotwords, hotwordSpelling } from '../electron/speech/hotwords';
import { normalizeHotword, supportsHotwords } from '../shared/hotwords';
import { RECOGNITION_LANGUAGES } from '../shared/speech-contracts';

test('hotwords are enabled only for exclusively Mandarin and English selections', () => {
  assert.equal(supportsHotwords(['zh']), true);
  assert.equal(supportsHotwords(['en']), true);
  assert.equal(supportsHotwords(['zh', 'en']), true);
  assert.equal(supportsHotwords(RECOGNITION_LANGUAGES), false);
  assert.equal(supportsHotwords(['zh', 'yue']), false);
  assert.equal(supportsHotwords([]), false);
});

test('the decoder receives a phonetic spelling and storage retains the user’s display spelling', () => {
  assert.deepEqual(normalizeHotword({ text: '  OnoSan ', aliases: [' Ono San ', 'ono san', '', 'ONOSAN'] }),
    { text: 'OnoSan', aliases: ['Ono San'] });
  assert.equal(normalizeHotword({ text: '  ' }), null);
  assert.equal(hotwordSpelling('  AI-Hub: 吴若兰 / José  '), 'AI HUB 吴若兰 JOSE');
});

test('a hotword found by the decoder replaces the matching phrase while punctuation and casing outside it stay intact', () => {
  assert.equal(applyHotwords('Please send it to Fibi Nwin, after lunch.', 'PLEASE SEND IT TO PHOEBE NGUYEN AFTER LUNCH',
    [{ text: 'Phoebe Nguyen', aliases: [] }]), 'Please send it to Phoebe Nguyen, after lunch.');
  assert.equal(applyHotwords('下午把纪要发给卢志新。下次再讨论。', '下午把纪要发给陆志鑫下次再讨论',
    [{ text: '陆志鑫', aliases: [] }]), '下午把纪要发给陆志鑫。下次再讨论。');
  assert.equal(applyHotwords('The meeting starts at four.', '请把纪要发给陆志鑫', [{ text: '陆志鑫', aliases: [] }]),
    'The meeting starts at four.');
});

test('explicit aliases and canonical capitalization use whole English words and never chain', () => {
  assert.equal(applyHotwords('打开欧诺桑、ONOSAN、ono san 和 onosanized。', '',
    [{ text: 'OnoSan', aliases: ['欧诺桑', 'ono san'] }]), '打开OnoSan、OnoSan、OnoSan 和 onosanized。');
  assert.equal(applyHotwords('a+b和xa+by', '', [{ text: 'A+B', aliases: [] }]), 'A+B和xa+by');
});

test('isolated names can be corrected and canonical punctuation is preserved once', () => {
  const words = [{ text: '陆志鑫', aliases: [] }, { text: 'C++', aliases: [] }, { text: 'José', aliases: [] }];
  assert.equal(applyHotwords('卢志新。', '陆志鑫', words), '陆志鑫。');
  assert.equal(applyHotwords('Use c++ to build this.', 'USE C PLUS PLUS TO BUILD THIS', words), 'Use C++ to build this.');
  assert.equal(applyHotwords('vitamin c', 'VITAMIN C', words), 'vitamin c');
  assert.equal(applyHotwords('Hi José.', 'HI JOSE', words), 'Hi José.');
});

test('a repeated character in the biased result still needs context and an unambiguous same-length Chinese span', () => {
  const hotwords = [{ text: '吴若蓝', aliases: [] }];
  assert.equal(applyHotwords('记得把github上的修改发给吴若兰。', '记得把这个 G上的修改发给吴吴若蓝岚兰', hotwords),
    '记得把github上的修改发给吴若蓝。');
  assert.equal(applyHotwords('请把修改发给大家。', '请把修改发给吴吴若蓝岚兰', hotwords), '请把修改发给大家。');
});
