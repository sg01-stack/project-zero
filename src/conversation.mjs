import { NeuralVoice } from './voice.mjs';

export class SpeechRecognizer extends NeuralVoice {
  constructor(onProgress) { super(onProgress, '/src/asr-worker.mjs'); this.model = 'base'; }
  load(model = this.model) {
    if (model !== this.model) this.cancel();
    this.model = model;
    return this.ready ? Promise.resolve() : this.request('load', { model });
  }
  transcribe(pcm) { return this.request('transcribe', { pcm: prepareSpeech(pcm) }); }
}

// Condition only the ASR copy. Keep the detector's levels/noise floor intact.
// Bounded gain helps quiet consonants without clipping or amplifying silence.
// This cannot recover whispered phonemes that the microphone did not capture.
export function prepareSpeech(input) {
  const output = new Float32Array(input.length);
  let previous = 0, filtered = 0, energy = 0, peak = 0;
  const alpha = Math.exp(-2 * Math.PI * 70 / 16000);
  for (let i = 0; i < input.length; i++) {
    const value = Number.isFinite(input[i]) ? input[i] : 0;
    filtered = alpha * (filtered + value - previous); previous = value;
    output[i] = filtered; energy += filtered * filtered; peak = Math.max(peak, Math.abs(filtered));
  }
  const rms = Math.sqrt(energy / Math.max(1, input.length));
  const gain = rms < 0.0003 ? 1 : Math.min(8, Math.max(1, 0.06 / rms), 0.95 / Math.max(peak, 0.000001));
  for (let i = 0; i < output.length; i++) output[i] *= gain;
  return output;
}

// 50 ms frames divide cleanly into 800 samples at 16 kHz. Weighted averaging
// provides a simple low-pass resampling step for browser capture rates.
export function speechSamples(samples, sampleRate) {
  if (!Number.isFinite(sampleRate) || sampleRate < 16000) throw new Error('Speech recognition needs a capture rate of at least 16 kHz.');
  const ratio = sampleRate / 16000, output = new Float32Array(Math.round(samples.length / ratio));
  for (let i = 0; i < output.length; i++) {
    const start = i * ratio, end = Math.min(samples.length, (i + 1) * ratio);
    let total = 0;
    for (let j = Math.floor(start); j < Math.ceil(end); j++) total += samples[j] * (Math.min(j + 1, end) - Math.max(j, start));
    output[i] = total / (end - start);
  }
  return output;
}

export class SpeechBuffer {
  constructor() { this.frames = []; }
  push(samples, rate, endMs) {
    this.frames.push({ endMs, pcm: speechSamples(samples, rate) });
    while (this.frames.length && this.frames[0].endMs < endMs - 35000) this.frames.shift();
  }
  between(startMs, endMs) {
    const frames = this.frames.filter(frame => frame.endMs > Math.max(0, startMs - 250) && frame.endMs <= endMs + 100);
    const pcm = new Float32Array(frames.reduce((sum, frame) => sum + frame.pcm.length, 0));
    let offset = 0;
    for (const frame of frames) { pcm.set(frame.pcm, offset); offset += frame.pcm.length; }
    return pcm;
  }
  clear() { this.frames = []; }
}

export function vocalDelivery(frame, previous = { intensity: 0.3, soft: false }) {
  if (!['voiced_speech', 'whisper_like', 'uncertain_audio'].includes(frame.state)) return previous;
  const intensity = Math.min(1, Math.max(0, (frame.level_dbfs - frame.noise_floor_dbfs - 6) / 38));
  return { intensity: previous.intensity * 0.8 + intensity * 0.2, soft: frame.state === 'whisper_like' };
}
