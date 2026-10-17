import test from 'node:test';
import assert from 'node:assert/strict';
import { speechSegments, voicePosition, VOICE_PRESETS } from '../src/voice.mjs';

test('speech chunks preserve words and punctuation without silently truncating long replies', () => {
  const text = 'Dr. Vale is here. “Listen carefully!” ' + 'A distant door opens slowly. '.repeat(80) + 'x'.repeat(900);
  const chunks = speechSegments(text);
  assert.ok(chunks.every(chunk => chunk.length > 0 && chunk.length <= 400));
  assert.equal(chunks.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
  assert.deepEqual(speechSegments(''), []);
});

test('voice placement changes sides, recedes with a darker spectrum, and moves around the listener', () => {
  const left = voicePosition({ ...VOICE_PRESETS.guide, angle: -90 });
  const right = voicePosition({ ...VOICE_PRESETS.guide, angle: 90 });
  assert.ok(left.x < 0 && right.x > 0);
  const far = voicePosition(VOICE_PRESETS.hall);
  assert.ok(far.distance > left.distance && far.cutoff < left.cutoff);
  assert.ok(voicePosition(VOICE_PRESETS.passing, 0).x < 0);
  assert.ok(voicePosition(VOICE_PRESETS.passing, 8).x > 0);
  assert.ok(voicePosition(VOICE_PRESETS.orbit, 0).z < 0);
  assert.ok(voicePosition(VOICE_PRESETS.orbit, 7.5).z > 0);
  const invalid = voicePosition({ angle: NaN, distance: Infinity, room: -4 });
  assert.ok(Object.values(invalid).every(Number.isFinite)); assert.equal(invalid.room, 0);
});
