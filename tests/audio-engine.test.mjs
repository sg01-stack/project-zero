import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine, extractFeatures } from '../src/audio-engine.mjs';

let seed = 541;
function random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; }
function pcm(type, index = 0, amplitude = 0.1, rate = 16000) {
  const result = new Float32Array(Math.round(rate * 0.05));
  let low = 0, high = 0;
  for (let i = 0; i < result.length; i++) {
    const time = (index * result.length + i) / rate;
    const noise = random();
    low += (1 - Math.exp(-2 * Math.PI * 500 / rate)) * (noise - low);
    high += (1 - Math.exp(-2 * Math.PI * 5500 / rate)) * (noise - low - high);
    if (type === 'voice') result[i] = amplitude * (0.7 * Math.sin(2 * Math.PI * 160 * time) + 0.2 * Math.sin(2 * Math.PI * 480 * time) + 0.1 * Math.sin(2 * Math.PI * 960 * time));
    if (type === 'whisper') result[i] = amplitude * high * (0.3 + 0.7 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * time)));
    if (type === 'hiss') result[i] = amplitude * noise;
    if (type === 'snap') result[i] = amplitude * noise * Math.exp(-i / (rate * 0.004));
    if (type === 'breath') result[i] = amplitude * low;
  }
  return result;
}
function harness(options = {}) {
  const turns = [], events = [], states = [];
  const engine = new AudioEngine({ calibrationMs: 0, initialNoiseDb: -65, sessionId: 'test',
    onTurn: p => turns.push(p), onEvent: p => events.push(p), onFrame: f => states.push(f), ...options });
  let index = 0;
  const feed = (type, count, amplitude = 0.1, rate = 16000) => {
    for (let i = 0; i < count; i++) engine.process(pcm(type, index++, amplitude, rate), rate);
  };
  return { engine, turns, events, states, feed };
}

test('features use normalized levels and voicing at common microphone sample rates', () => {
  for (const rate of [16000, 44100, 48000]) {
    const f = extractFeatures(pcm('voice', 0, 0.1, rate), rate);
    assert.ok(f.periodicity > 0.9);
    assert.ok(Math.abs(f.pitchHz - 160) < 5, `${rate}: ${f.pitchHz}`);
    assert.ok(f.dbfs < -20 && f.dbfs > -30);
    const hiss = extractFeatures(pcm('hiss', 0, 0.1, rate), rate);
    assert.ok(hiss.periodicity < 0.65);
    assert.equal(hiss.pitchHz, null);
  }
});

test('silence produces neither turns nor noise events', () => {
  const h = harness(); h.feed('silence', 100);
  assert.equal(h.turns.length, 0); assert.equal(h.events.length, 0);
});

test('quiet and loud voiced speech are speech, not whispers or spikes', () => {
  for (const amplitude of [0.008, 0.15, 0.9]) {
    const h = harness(); h.feed('voice', 30, amplitude); h.feed('silence', 20);
    assert.equal(h.turns.length, 1);
    assert.equal(h.turns[0].prosody_analysis.dominant_style, 'voiced_speech');
    assert.equal(h.events.length, 0);
    assert.equal(h.turns[0].timing.start_ms, 0);
    assert.equal(h.turns[0].timing.active_audio_ms, 1500);
    assert.equal(h.turns[0].transcript, null);
  }
});

test('sustained modulated unvoiced whisper-like PCM does not become a transient', () => {
  for (const rate of [16000, 44100, 48000]) {
    for (const amplitude of [0.025, 0.4]) {
      const h = harness(); h.feed('whisper', 40, amplitude, rate); h.feed('silence', 20, 0, rate);
      assert.equal(h.turns.length, 1, `${rate} ${amplitude}: ${JSON.stringify(h.events)}`);
      const payload = h.turns[0];
      assert.equal(payload.prosody_analysis.dominant_style, 'whisper_like');
      assert.equal(payload.quality.possible_non_speech, true);
      assert.equal(payload.speech_evidence.certainty, 'low');
      assert.equal(h.events.length, 0);
    }
  }
});

test('an isolated snap waits for decay and produces an event, not an LLM turn', () => {
  const h = harness(); h.feed('snap', 1, 0.9);
  assert.equal(h.events.length, 0); h.feed('silence', 3);
  assert.equal(h.events.length, 1); assert.equal(h.events[0].audio_type, 'transient');
  assert.equal(h.turns.length, 0);
});

test('two brief burst frames remain a transient while a short voiced word is uncertain', () => {
  const noise = harness(); noise.feed('hiss', 2, 0.6); noise.feed('silence', 20);
  assert.equal(noise.events[0].audio_type, 'transient'); assert.equal(noise.turns.length, 0);
  const voice = harness(); voice.feed('voice', 2); voice.feed('silence', 20);
  assert.equal(voice.events[0].audio_type, 'uncertain_short_audio');
});

test('unvoiced consonants and short pauses do not flip an established speech style', () => {
  const h = harness(); h.feed('voice', 15); h.feed('hiss', 3, 0.4);
  h.feed('voice', 10); h.feed('silence', 5); h.feed('voice', 10); h.feed('silence', 20);
  assert.equal(h.turns.length, 1); assert.equal(h.events.length, 0);
  const activeStates = h.states.slice(4).map(f => f.state);
  assert.ok(!activeStates.includes('transient'));
  assert.ok(!activeStates.includes('whisper_like'));
  assert.equal(h.turns[0].prosody_analysis.dominant_style, 'voiced_speech');
});

test('stationary hiss remains uncertain and does not invent a speech turn', () => {
  const h = harness(); h.feed('hiss', 50, 0.15); h.feed('silence', 20);
  assert.equal(h.turns.length, 0); assert.equal(h.events[0].audio_type, 'uncertain_audio');
});

test('a half-second unvoiced syllable inside speech retains the voiced style', () => {
  const h = harness(); h.feed('voice', 20); h.feed('whisper', 10); h.feed('voice', 20); h.feed('silence', 20);
  assert.equal(h.turns.length, 1);
  assert.equal(h.turns[0].prosody_analysis.style_duration_ms.whisper_like, 0);
  assert.equal(h.turns[0].prosody_analysis.style_duration_ms.uncertain_audio, 0);
});

test('dominant style uses duration, not the final classified frame; next turn resets', () => {
  const h = harness(); h.feed('voice', 60); h.feed('whisper', 20); h.feed('silence', 20);
  h.feed('whisper', 45); h.feed('silence', 20);
  assert.equal(h.turns.length, 2);
  assert.equal(h.turns[0].prosody_analysis.dominant_style, 'voiced_speech');
  assert.equal(h.turns[1].prosody_analysis.dominant_style, 'whisper_like');
  assert.notEqual(h.turns[0].turn_id, h.turns[1].turn_id);
});

test('turn IDs scope transcripts; interim results replace instead of duplicate', () => {
  const h = harness(); h.feed('voice', 15);
  const id = h.engine.turn.id;
  assert.equal(h.engine.setTranscript({ turnId: 'old-turn', text: 'wrong' }), false);
  assert.equal(h.engine.setTranscript({ turnId: id, text: 'go' }), true);
  assert.equal(h.engine.setTranscript({ turnId: id, text: 'go left', isFinal: true }), true);
  h.feed('silence', 20);
  assert.equal(h.turns[0].transcript.text, 'go left');
  assert.equal(h.turns[0].speech_evidence.speech_confirmed_by_asr, true);
  assert.equal(h.engine.setTranscript({ turnId: id, text: 'too late' }), false);
});

test('calibration estimates stationary noise and rejects speech during calibration', () => {
  const quiet = harness({ calibrationMs: 1200 }); quiet.feed('hiss', 24, 0.0008);
  assert.equal(quiet.engine.calibrated, true); assert.equal(quiet.engine.calibrationFailed, false);
  assert.ok(quiet.engine.noiseDb > -70 && quiet.engine.noiseDb < -60);
  quiet.feed('voice', 20); quiet.feed('silence', 20); assert.equal(quiet.turns.length, 1);
  const contaminated = harness({ calibrationMs: 1200 }); contaminated.feed('voice', 30);
  assert.equal(contaminated.engine.calibrationFailed, true); assert.equal(contaminated.turns.length, 0);
});

test('long speech splits once per duration bound and manual stop flushes once', () => {
  const h = harness({ maxTurnMs: 1000 }); h.feed('voice', 45); h.engine.finish('manual_stop'); h.engine.finish('manual_stop');
  assert.equal(h.turns.length, 3);
  assert.deepEqual(h.turns.map(p => p.timing.end_reason), ['max_duration', 'max_duration', 'manual_stop']);
  assert.equal(h.turns[0].timing.continues, true);
  assert.equal(h.turns[2].timing.continues, false);
});

test('clipping is a quality flag; payload values are JSON-safe and per-turn', () => {
  const h = harness(); h.feed('voice', 20, 2); h.feed('silence', 20);
  const payload = JSON.parse(JSON.stringify(h.turns[0]));
  assert.equal(payload.quality.clipped, true); assert.equal(payload.quality.emotion_inferred, false);
  assert.equal(payload.event, 'user_turn_complete');
  assert.ok(Number.isFinite(payload.prosody_analysis.average_rms_dbfs));
  assert.ok(!JSON.stringify(payload).includes('NaN'));
});

test('invalid PCM is rejected instead of leaking NaN into JSON', () => {
  assert.throws(() => extractFeatures(new Float32Array([NaN, 1]), 16000));
  assert.throws(() => extractFeatures(new Float32Array(800), 0));
});
