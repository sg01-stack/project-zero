import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine } from '../src/audio-engine.mjs';
import { OfflineStory, sceneControls, tourFrame } from '../src/experience.mjs';

test('signal tours produce distinguishable speech, whisper-like and transient output', () => {
  for (const [kind, expected] of [['speech', 'voiced_speech'], ['whisper', 'whisper_like'], ['snap', 'transient']]) {
    const results = [];
    const detector = new AudioEngine({ onTurn: p => results.push(p), onEvent: p => results.push(p) });
    for (let i = 0; i < 80; i++) detector.push(tourFrame(kind, i));
    assert.equal(results.length, 1);
    assert.equal(results[0].prosody_analysis?.dominant_style || results[0].audio_type, expected);
  }
});

test('offline story uses typed actions and tentative delivery; scene controls stay bounded', () => {
  const story = new OfflineStory();
  assert.match(story.reply({ transcript: { text: 'left' } }), /left corridor/);
  assert.match(story.reply({ transcript: { text: 'right' } }), /courtyard/);
  assert.match(story.reply({ prosody_analysis: { dominant_style: 'whisper_like' } }), /lowers her voice/);
  for (const level_dbfs of [-160, -50, 0, 20]) {
    const controls = sceneControls({ state: 'voiced_speech', level_dbfs });
    assert.ok(controls.intensity >= 0 && controls.intensity <= 1);
    assert.ok(Math.abs(controls.pan) <= 1 && controls.gain < 0.05);
  }
});
