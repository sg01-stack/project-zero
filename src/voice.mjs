// Speech audio stays in the browser. System SpeechSynthesis cannot enter this
// Web Audio graph; only decoded/generated PCM receives spatial processing.
export const VOICE_PRESETS = Object.freeze({
  guide: { angle: -30, distance: 1.2, room: 0.16, motion: 'still', speed: 0.95 },
  intimate: { angle: -15, distance: 0.65, room: 0.05, motion: 'still', speed: 0.86 },
  hall: { angle: 35, distance: 7, room: 0.55, motion: 'still', speed: 0.92 },
  passing: { angle: -80, distance: 2, room: 0.24, motion: 'pass', speed: 1 },
  orbit: { angle: 0, distance: 2.5, room: 0.3, motion: 'orbit', speed: 0.96 },
});

export function voicePosition(options, elapsed = 0) {
  let angle = Number(options.angle), distance = Number(options.distance);
  if (options.motion === 'pass') { angle = -80 + Math.min(elapsed / 8, 1) * 160; distance *= 1 + Math.abs(angle) / 70; }
  if (options.motion === 'orbit') angle += elapsed * 24;
  angle = Number.isFinite(angle) ? angle : 0;
  distance = Number.isFinite(distance) ? Math.min(30, Math.max(0.5, distance)) : 1;
  const radians = angle * Math.PI / 180;
  return { x: Math.sin(radians) * distance, y: 0, z: -Math.cos(radians) * distance, distance, angle,
    cutoff: Math.max(1300, 14000 / (1 + distance * 0.42)),
    room: Math.min(0.65, Math.max(0, Number(options.room) || 0)) };
}

export function speechSegments(text) {
  const sentences = typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)].map(item => item.segment)
    : text.match(/[^.!?]+[.!?]*\s*/g) || [];
  const chunks = [];
  for (let sentence of sentences) {
    sentence = sentence.trim();
    while (sentence.length > 400) {
      const boundary = sentence.lastIndexOf(' ', 400);
      const at = boundary > 0 ? boundary : 400;
      chunks.push(sentence.slice(0, at)); sentence = sentence.slice(at).trim();
    }
    if (sentence) chunks.push(sentence);
  }
  return chunks;
}

export function createVoiceGraph(context) {
  const input = context.createGain();
  const filter = context.createBiquadFilter(); filter.type = 'lowpass';
  const panner = context.createPanner(); panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse';
  panner.refDistance = 1; panner.maxDistance = 30; panner.rolloffFactor = 0.65;
  const direct = context.createGain(), wet = context.createGain(), reverb = context.createConvolver();
  const output = context.createGain(); output.gain.value = 0.75;
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -6; limiter.knee.value = 6; limiter.ratio.value = 8;
  // Deterministic stereo room response; no downloaded impulse-response asset.
  const impulse = context.createBuffer(2, Math.round(context.sampleRate * 1.6), context.sampleRate);
  let seed = 17;
  for (let channel = 0; channel < 2; channel++) {
    const samples = impulse.getChannelData(channel);
    for (let i = 0; i < samples.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      samples[i] = (seed / 2147483648 - 1) * (1 - i / samples.length) ** 3;
    }
  }
  reverb.buffer = impulse;
  input.connect(filter); filter.connect(panner); panner.connect(direct); direct.connect(output);
  filter.connect(reverb); reverb.connect(wet); wet.connect(output);
  output.connect(limiter); limiter.connect(context.destination);
  const update = position => {
    const time = context.currentTime;
    for (const [name, value] of [['positionX', position.x], ['positionY', position.y], ['positionZ', position.z]]) {
      panner[name].setTargetAtTime(value, time, 0.06);
    }
    filter.frequency.setTargetAtTime(position.cutoff, time, 0.08);
    direct.gain.setTargetAtTime(1 - position.room * 0.35, time, 0.08);
    wet.gain.setTargetAtTime(position.room * 0.5 / (1 + position.distance * 0.08), time, 0.08);
  };
  return { input, panner, filter, direct, wet, update, disconnect() { for (const node of [input, filter, panner, direct, wet, reverb, output, limiter]) node.disconnect(); } };
}

export class SpatialVoice {
  constructor(onPosition = () => {}) { this.onPosition = onPosition; this.options = { ...VOICE_PRESETS.guide }; this.context = null; this.source = null; this.generation = 0; }
  async unlock() {
    if (!this.context || this.context.state === 'closed') { this.context = new AudioContext(); this.graph = createVoiceGraph(this.context); }
    let timer;
    try { await Promise.race([this.context.resume(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Audio output did not start. Check your output device and try again.')), 5000); })]); }
    finally { clearTimeout(timer); }
  }
  configure(options) { this.options = { ...options }; this.graph?.update(voicePosition(this.options)); }
  modulate(delivery) { this.delivery = delivery; }
  currentPosition(elapsed = 0) {
    const options = { ...this.options };
    if (this.delivery) {
      options.distance *= this.delivery.soft ? 0.7 : 0.9 + this.delivery.intensity * 0.3;
      options.room = Math.min(0.65, options.room + this.delivery.intensity * 0.08);
    }
    return voicePosition(options, elapsed);
  }
  async play(pcm, sampleRate, withTail = true) {
    if (!this.context || this.context.state !== 'running') throw new Error('Initialize audio output from the play button first.');
    this.stop();
    const context = this.context, generation = this.generation;
    const buffer = context.createBuffer(1, pcm.length, sampleRate); buffer.copyToChannel(pcm, 0);
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(this.graph.input); this.source = source;
    const began = this.sceneStarted ??= context.currentTime;
    this.graph.update(this.currentPosition());
    this.timer = setInterval(() => {
      const position = this.currentPosition(context.currentTime - began);
      this.graph.update(position); this.onPosition(position);
    }, 40);
    await new Promise(resolve => {
      this.resolvePlayback = resolve;
      source.onended = () => {
        if (generation !== this.generation) return;
        source.disconnect(); this.source = null;
        // Keep the tail audible, but permit Stop to interrupt it.
        this.tail = setTimeout(() => { clearInterval(this.timer); this.resolvePlayback = null; resolve(); }, withTail && this.options.room > 0 ? 1600 : 0);
      };
      source.start();
    });
  }
  stop() {
    this.generation++; clearInterval(this.timer); clearTimeout(this.tail);
    if (this.source) { this.source.onended = null; try { this.source.stop(); } catch {} this.source.disconnect(); this.source = null; }
    this.resolvePlayback?.(); this.resolvePlayback = null;
  }
  interrupt() { this.stop(); if (this.context) { this.graph.disconnect(); this.graph = createVoiceGraph(this.context); } }
  async close() { this.stop(); const context = this.context; this.context = null; if (context && context.state !== 'closed') await context.close(); }
}

export class NeuralVoice {
  constructor(onProgress = () => {}, workerPath = '/src/neural-worker.mjs') { this.onProgress = onProgress; this.workerPath = workerPath; this.worker = null; this.pending = null; this.ready = false; this.id = 0; }
  async request(type, values = {}) {
    if (!['http:', 'https:'].includes(location.protocol)) throw new Error('Neural voices need the full app. Launch Start EchoSphere.cmd or npm start.');
    if (this.pending) throw new Error('Wait for the current voice operation to finish.');
    if (!this.worker) {
      this.worker = new Worker(new URL(this.workerPath, location.href), { type: 'module' });
      this.worker.onmessage = ({ data }) => {
        if (data.type === 'progress') { this.onProgress(data.message); return; }
        if (data.id !== this.pending?.id) return;
        clearTimeout(this.pending.timer);
        const { resolve, reject } = this.pending; this.pending = null;
        if (data.type === 'error') reject(new Error(data.message));
        else { if (data.type === 'loaded') this.ready = true; resolve(data); }
      };
      this.worker.onerror = () => this.cancel('Could not start the local model worker. Open the hosted app or use the project launcher.');
    }
    const result = new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => this.cancel('Voice loading or generation timed out. Check model-download access, or choose a system voice.'), 180000);
      this.pending = { id, type, resolve, reject, timer }; this.worker.postMessage({ id, type, ...values });
    });
    this.idle = result.catch(() => {}); return result;
  }
  load() { return this.ready ? Promise.resolve() : this.request('load'); }
  generate(text, voice, speed) { return this.request('generate', { text, voice, speed }); }
  cancel(message = 'Voice operation stopped.') {
    this.worker?.terminate(); this.worker = null; this.ready = false;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error(message)); this.pending = null; }
  }
}
