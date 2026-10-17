import test from 'node:test';
import assert from 'node:assert/strict';
import { speechSamples, SpeechBuffer, vocalDelivery } from '../src/conversation.mjs';

test('speech resampling preserves frame duration and a low-frequency speech tone at capture rates', () => {
  for (const rate of [16000, 44100, 48000]) {
    const input = Float32Array.from({ length: rate * 0.05 }, (_, i) => Math.sin(2 * Math.PI * 160 * i / rate));
    const output = speechSamples(input, rate);
    assert.equal(output.length, 800);
    const rms = Math.sqrt(output.reduce((sum, sample) => sum + sample * sample, 0) / output.length);
    assert.ok(rms > 0.69 && rms < 0.72);
  }
});
test('recognition PCM is bounded and selected from the exact acoustic segment with padding', () => {
  const buffer = new SpeechBuffer();
  for (let i = 1; i <= 800; i++) buffer.push(new Float32Array(800).fill(i), 16000, i * 50);
  assert.ok(buffer.frames.length <= 701);
  const selected = buffer.between(38000, 39000);
  assert.equal(selected.length, 24 * 800);
  assert.equal(selected[0], 759); assert.equal(selected.at(-1), 782);
  buffer.clear(); assert.equal(buffer.frames.length, 0);
});
test('vocal delivery keeps a soft voice profile across pauses without assigning emotion', () => {
  const soft = vocalDelivery({ state: 'whisper_like', level_dbfs: -45, noise_floor_dbfs: -65 });
  assert.equal(soft.soft, true);
  assert.deepEqual(vocalDelivery({ state: 'silence' }, soft), soft);
  assert.ok(vocalDelivery({ state: 'voiced_speech', level_dbfs: -15, noise_floor_dbfs: -65 }, soft).intensity > soft.intensity);
});
