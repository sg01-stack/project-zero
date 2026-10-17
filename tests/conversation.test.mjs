import test from 'node:test';
import assert from 'node:assert/strict';
import { speechSamples, SpeechBuffer, vocalDelivery, prepareSpeech } from '../src/conversation.mjs';

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
  assert.equal(selected.length, 27 * 800);
  assert.equal(selected[0], 756); assert.equal(selected.at(-1), 782);
  buffer.clear(); assert.equal(buffer.frames.length, 0);
});

test('ASR conditioning boosts quiet speech, rejects DC, preserves the source and avoids clipping', () => {
  const pcm = Float32Array.from({ length: 16000 }, (_, i) => 0.01 * Math.sin(i * 2 * Math.PI * 1800 / 16000));
  const original = pcm.slice(), result = prepareSpeech(pcm);
  const rms = values => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
  assert.deepEqual(pcm, original);
  assert.ok(rms(result) > rms(pcm) * 6 && rms(result) <= rms(pcm) * 8.01);
  assert.equal(result.length, pcm.length);
  const dc = prepareSpeech(new Float32Array(16000).fill(0.05));
  assert.ok(rms(dc.slice(8000)) < 0.000001);
  const loud = prepareSpeech(Float32Array.from(pcm, value => value * 150));
  assert.ok(loud.every(value => Number.isFinite(value) && Math.abs(value) <= 0.950001));
  assert.ok(prepareSpeech(new Float32Array(16000)).every(value => value === 0));
});
test('vocal delivery keeps a soft voice profile across pauses without assigning emotion', () => {
  const soft = vocalDelivery({ state: 'whisper_like', level_dbfs: -45, noise_floor_dbfs: -65 });
  assert.equal(soft.soft, true);
  assert.deepEqual(vocalDelivery({ state: 'silence' }, soft), soft);
  assert.ok(vocalDelivery({ state: 'voiced_speech', level_dbfs: -15, noise_floor_dbfs: -65 }, soft).intensity > soft.intensity);
});
