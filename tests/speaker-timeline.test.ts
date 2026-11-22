import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSpeakerSpans, labelSpeakerGroups, meetingSpeakerForUtterance } from '../electron/speech/speaker-timeline';
import { SPEECH_SAMPLE_RATE as rate } from '../shared/speech-contracts';

test('speaker timeline retains overlap, brief turns, and unassigned audio', () => {
  const timeline = buildSpeakerSpans([
    { start: .5, end: 4, speaker: 7 },
    { start: 3, end: 6.5, speaker: 4 },
    { start: 7, end: 7.8, speaker: 7 },
  ], 8 * rate);
  assert.deepEqual(timeline.map(({ start, end, group }) => [start / rate, end / rate, group]), [
    [0, .5, null], [.5, 3, 7], [3, 4, null], [4, 6.5, 4], [6.5, 8, null],
  ]);
});

test('a meeting utterance can use agreeing short spans without claiming overlapping speech', () => {
  const segments = [{ start: .5, end: 1.45, speaker: 0 }, { start: 2.05, end: 3.1, speaker: 0 }];
  const findSpeaker = (detections = segments) => meetingSpeakerForUtterance(
    detections, buildSpeakerSpans(detections, 4 * rate, 0), .5 * rate, 3.5 * rate,
  );
  assert.equal(findSpeaker(), 0);
  assert.equal(findSpeaker([{ start: .5, end: 1.45, speaker: 0 }]), null);
  assert.equal(findSpeaker([...segments, { start: .75, end: 1.1, speaker: 1 }]), null);
  assert.equal(findSpeaker([segments[0], { ...segments[1], speaker: 1 }]), null);
});

test('a unique voiceprint match replaces only the matching label', () => {
  assert.deepEqual([...labelSpeakerGroups([7, 4], new Map([[7, .2], [4, .8]]))], [[7, 'b'], [4, 'self']]);
});

test('similar profile scores and absent profiles keep anonymous labels', () => {
  const expected = [[7, 'a'], [4, 'b']];
  assert.deepEqual([...labelSpeakerGroups([7, 4], new Map([[7, .75], [4, .72]]))], expected);
  assert.deepEqual([...labelSpeakerGroups([7, 4], new Map())], expected);
});

test('a third candidate stays unconfirmed in a two-person recording', () => {
  assert.deepEqual([...labelSpeakerGroups([7, 4, 9], new Map())], [[7, 'a'], [4, 'b'], [9, 'unknown']]);
});
