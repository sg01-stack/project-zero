(() => {
'use strict';
// Dependency-free acoustic heuristics. Scores are evidence strengths, not
// calibrated probabilities; whispering vs breath/noise needs local ASR/VAD.
const DEFAULTS = Object.freeze({
  frameMs: 50,
  calibrationMs: 1200,
  initialNoiseDb: -65,
  gateMarginDb: 9,
  gateReleaseMarginDb: 5,
  minimumGateDb: -70,
  candidateMs: 200,
  endSilenceMs: 800,
  styleHoldMs: 300,
  minimumSpeechMs: 250,
  maxTurnMs: 30000,
});

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const db = (x) => 20 * Math.log10(Math.max(x, 1e-8));
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const rounded = (x, n = 2) => Number(x.toFixed(n));
const quantile = (xs, q) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) * q)] : 0;
};

function spectrum(samples) {
  // 512 samples at 16 kHz: 32 ms Hann window; radix-2 FFT.
  const n = 512;
  const real = new Float64Array(n);
  const imag = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    real[i] = (samples[i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
  }
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [real[i], real[j]] = [real[j], real[i]];
  }
  for (let size = 2; size <= n; size *= 2) {
    for (let start = 0; start < n; start += size) {
      for (let j = 0; j < size / 2; j++) {
        const angle = -2 * Math.PI * j / size;
        const c = Math.cos(angle), s = Math.sin(angle);
        const a = start + j, b = a + size / 2;
        const re = real[b] * c - imag[b] * s;
        const im = real[b] * s + imag[b] * c;
        real[b] = real[a] - re; imag[b] = imag[a] - im;
        real[a] += re; imag[a] += im;
      }
    }
  }
  let total = 0, low = 0, voice = 0, high = 0, logSum = 0, count = 0;
  for (let i = 1; i < n / 2; i++) {
    const hz = i * 16000 / n;
    const power = real[i] ** 2 + imag[i] ** 2 + 1e-18;
    total += power;
    if (hz < 250) low += power;
    if (hz >= 250 && hz <= 6000) voice += power;
    if (hz >= 1500 && hz <= 6000) high += power;
    if (hz >= 250 && hz <= 6000) { logSum += Math.log(power); count++; }
  }
  return {
    lowRatio: low / Math.max(total, 1e-18),
    speechBandRatio: voice / Math.max(total, 1e-18),
    highRatio: high / Math.max(total, 1e-18),
    flatness: Math.exp(logSum / count) / Math.max(voice / count, 1e-18),
  };
}

function extractFeatures(input, sampleRate, frameMs = DEFAULTS.frameMs) {
  if (!input?.length || !Number.isFinite(sampleRate) || sampleRate < 8000) {
    throw new TypeError('Expected PCM samples and a valid sample rate.');
  }
  let energy = 0, peak = 0, crossings = 0, clipped = 0;
  // Remove DC before measuring. Mic offsets otherwise bias the energy gate.
  const offset = mean(input);
  for (let i = 0; i < input.length; i++) {
    const x = input[i] - offset;
    if (!Number.isFinite(x)) throw new TypeError('PCM samples must be finite.');
    energy += x * x;
    peak = Math.max(peak, Math.abs(x));
    if (Math.abs(input[i]) >= 0.99) clipped++;
    if (i && (x >= 0) !== (input[i - 1] - offset >= 0)) crossings++;
  }
  const rms = Math.sqrt(energy / input.length);
  // Average source intervals when downsampling, keeping features approximately
  // comparable at 16/44.1/48 kHz. This is a lightweight analysis resampler.
  const count = Math.round(input.length * 16000 / sampleRate);
  const samples = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * sampleRate / 16000);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * sampleRate / 16000)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j] - offset;
    samples[i] = sum / (end - start);
  }
  // Normalized autocorrelation on a low-pass version suppresses unvoiced hiss.
  const voiced = new Float64Array(count);
  let filtered = 0;
  const alpha = 1 - Math.exp(-2 * Math.PI * 1200 / 16000);
  for (let i = 0; i < count; i++) { filtered += alpha * (samples[i] - filtered); voiced[i] = filtered; }
  let periodicity = 0, bestLag = 0;
  const correlations = [];
  for (let lag = 32; lag <= Math.min(228, count >> 1); lag++) {
    let xy = 0, xx = 0, yy = 0;
    for (let i = lag; i < count; i++) {
      const x = voiced[i], y = voiced[i - lag];
      xy += x * y; xx += x * x; yy += y * y;
    }
    correlations[lag] = xy / Math.max(Math.sqrt(xx * yy), 1e-15);
    if (correlations[lag] > periodicity) { periodicity = correlations[lag]; bestLag = lag; }
  }
  // Prefer the first strong local peak to a multiple of the fundamental period.
  for (let lag = 33; lag < correlations.length - 1; lag++) {
    if (correlations[lag] >= Math.max(0.65, periodicity * 0.92) &&
        correlations[lag] > correlations[lag - 1] && correlations[lag] >= correlations[lag + 1]) {
      bestLag = lag; break;
    }
  }
  return {
    frameMs, rms, dbfs: db(rms), peakDbfs: db(peak),
    crestDb: db(peak / Math.max(rms, 1e-8)),
    zeroCrossingsPerSecond: crossings * sampleRate / input.length,
    periodicity: clamp(periodicity, 0, 1),
    pitchHz: periodicity >= 0.65 && rms > 1e-6 ? 16000 / bestLag : null,
    clippedFraction: clipped / input.length,
    ...spectrum(samples),
  };
}

class AudioEngine {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.onFrame = options.onFrame || (() => {});
    this.onEvent = options.onEvent || (() => {});
    this.onTurn = options.onTurn || (() => {});
    this.sessionId = options.sessionId || globalThis.crypto.randomUUID();
    this.sequence = 0;
    this.timeMs = 0;
    this.noiseDb = this.options.initialNoiseDb;
    this.calibration = [];
    this.calibrated = this.options.calibrationMs === 0;
    this.calibrationFailed = false;
    this.previousDb = this.noiseDb;
    this.silenceMs = 0;
    this.activeGate = false;
    this.resetTurn();
  }

  resetTurn() {
    this.turn = null;
    this.pending = [];
    this.history = [];
    this.lastVoicedMs = -Infinity;
    this.style = null;
    this.proposedStyle = null;
    this.proposedMs = 0;
    this.quietHistory = [];
    this.silenceMs = 0;
  }

  process(samples, sampleRate) {
    return this.push(extractFeatures(samples, sampleRate, this.options.frameMs));
  }

  push(features) {
    const f = { ...features, frameMs: this.options.frameMs };
    this.timeMs += f.frameMs;
    f.timeMs = this.timeMs;
    f.onsetDb = f.dbfs - this.previousDb;
    this.previousDb = f.dbfs;
    if (!this.calibrated) {
      this.calibration.push(f);
      if (this.calibration.length * f.frameMs >= this.options.calibrationMs) {
        const levels = this.calibration.map(x => x.dbfs);
        // Reject speech and variable bursts during calibration. A steady loud
        // environment is also unsuitable for this simple microphone detector.
        this.calibrationFailed = mean(this.calibration.map(x => x.periodicity > 0.65 ? 1 : 0)) > 0.2 ||
          quantile(levels, 0.9) - quantile(levels, 0.1) > 12 || quantile(levels, 0.5) > -25;
        this.noiseDb = clamp(quantile(levels, 0.5), -90, -25);
        this.calibrated = true;
      }
      return this.report(this.calibrationFailed ? 'calibration_needed' : 'calibrating', f);
    }
    if (this.calibrationFailed) return this.report('calibration_needed', f);

    const threshold = Math.max(this.options.minimumGateDb,
      this.noiseDb + (this.activeGate ? this.options.gateReleaseMarginDb : this.options.gateMarginDb));
    this.activeGate = f.dbfs > threshold;
    if (this.activeGate) {
      if (f.periodicity >= 0.65) this.lastVoicedMs = this.timeMs;
      this.quietHistory = [];
      this.silenceMs = 0;
      this.history.push(f);
      this.history = this.history.filter(x => this.timeMs - x.timeMs < 1000);
      if (!this.turn) {
        this.pending.push(f);
        if (this.pending.length * f.frameMs < this.options.candidateMs) return this.report('candidate', f);
        const evidence = this.evidence();
        this.openTurn();
        for (const p of this.pending) this.accumulate(p, evidence);
        this.pending = [];
      } else {
        this.accumulate(f, this.evidence());
      }
      const state = this.style || 'uncertain_audio';
      const report = this.report(state, f);
      if (this.timeMs - this.turn.startMs >= this.options.maxTurnMs) this.finish('max_duration', true);
      return report;
    }

    this.silenceMs += f.frameMs;
    // Only adapt on sustained idle frames, never on speech or a turn's pause.
    if (!this.turn && !this.pending.length) {
      this.quietHistory.push(f.dbfs);
      if (this.quietHistory.length >= 20) {
        this.noiseDb = clamp(this.noiseDb * 0.95 + quantile(this.quietHistory, 0.5) * 0.05, -90, -25);
        this.quietHistory.shift();
      }
    }
    if (this.pending.length && this.silenceMs >= 150) {
      const burst = this.pending;
      const voicedMs = burst.filter(x => x.periodicity >= 0.65).length * f.frameMs;
      // Sharp attack AND fast decay AND little voicing. High RMS/ZCR alone
      // are never a transient. Very short voiced words remain uncertain audio.
      const isTransient = voicedMs === 0 && (burst[0].onsetDb >= 15 || burst.some(x => x.crestDb >= 13));
      this.emitAudioEvent(isTransient ? 'transient' : 'uncertain_short_audio', burst);
      this.pending = [];
      this.history = [];
      return this.report(isTransient ? 'transient' : 'uncertain_audio', f);
    }
    if (this.turn && this.silenceMs >= this.options.endSilenceMs) {
      this.finish('silence');
      return this.report('silence', f);
    }
    return this.report(this.turn ? 'pause' : this.pending.length ? 'candidate' : 'silence', f);
  }

  evidence() {
    const h = this.history;
    const recent = h.filter(f => this.timeMs - f.timeMs <= 250);
    const voicedShare = mean(recent.map(f => f.periodicity >= 0.65 ? 1 : 0));
    if (voicedShare >= 0.34) return { style: 'voiced_speech', score: 0.8 };
    // Natural speech contains long unvoiced consonants. Require a sustained
    // absence of voicing before changing an established voiced delivery style.
    if (this.style === 'voiced_speech' && this.timeMs - this.lastVoicedMs <= 700) {
      return { style: 'voiced_speech', score: 0.6 };
    }
    const span = h.length * this.options.frameMs;
    const levels = h.map(f => f.dbfs);
    const modulation = quantile(levels, 0.9) - quantile(levels, 0.1);
    const breathLike = mean(h.map(f => f.lowRatio)) > 0.55;
    const speechBand = mean(h.map(f => f.speechBandRatio));
    const highBand = mean(h.map(f => f.highRatio));
    // Whisper-like is deliberately a tentative acoustic label. Require
    // sustained, varying unvoiced sound; stationary fan hiss stays uncertain.
    if (span >= 350 && modulation >= 3 && modulation <= 25 &&
        speechBand >= 0.55 && highBand >= 0.15 && !breathLike) {
      return { style: 'whisper_like', score: 0.55 };
    }
    return { style: 'uncertain_audio', score: 0.25 };
  }

  openTurn() {
    this.turn = {
      id: `${this.sessionId}:${++this.sequence}`,
      startMs: (this.pending[0]?.timeMs ?? this.timeMs) - this.options.frameMs,
      lastActiveMs: this.timeMs,
      frames: [], transcript: null,
      styles: { voiced_speech: 0, whisper_like: 0, uncertain_audio: 0 },
    };
  }

  accumulate(f, evidence) {
    if (!this.style) this.style = evidence.style;
    if (evidence.style !== this.style) {
      if (evidence.style !== this.proposedStyle) { this.proposedStyle = evidence.style; this.proposedMs = 0; }
      this.proposedMs += f.frameMs;
      // Unknown at an onset may be resolved promptly. Established styles
      // require a sustained change: a consonant cannot flip speech to whisper.
      const required = this.style === 'uncertain_audio' ? 100 : this.options.styleHoldMs;
      if (this.proposedMs >= required) { this.style = evidence.style; this.proposedStyle = null; this.proposedMs = 0; }
    } else { this.proposedStyle = null; this.proposedMs = 0; }
    this.turn.styles[this.style] += f.frameMs;
    this.turn.frames.push({ ...f, style: this.style, evidenceScore: evidence.score });
    this.turn.lastActiveMs = f.timeMs;
  }

  // Feed a local ASR's cumulative transcript, not concatenated interim results.
  // Turn ID is required so delayed results cannot contaminate the next turn.
  setTranscript({ turnId, text, isFinal = false, source = 'local_asr' }) {
    if (!this.turn || turnId !== this.turn.id || typeof text !== 'string' || !text.trim()) return false;
    this.turn.transcript = { text: text.trim(), is_final: Boolean(isFinal), source: String(source) };
    return true;
  }

  emitAudioEvent(type, frames) {
    this.onEvent({
      schema_version: '1.0', event: 'audio_event', session_id: this.sessionId,
      event_id: `${this.sessionId}:event:${++this.sequence}`,
      audio_type: type,
      start_ms: frames[0].timeMs - this.options.frameMs,
      end_ms: frames.at(-1).timeMs,
      peak_dbfs: rounded(Math.max(...frames.map(f => f.peakDbfs))),
      speech_confirmed: false,
    });
  }

  finish(reason = 'manual_stop', continued = false) {
    const turn = this.turn;
    if (!turn) {
      if (this.pending.length) this.emitAudioEvent('uncertain_short_audio', this.pending);
      this.resetTurn();
      return null;
    }
    const frames = turn.frames;
    const knownMs = turn.styles.voiced_speech + turn.styles.whisper_like;
    if (knownMs < this.options.minimumSpeechMs && !turn.transcript) {
      this.emitAudioEvent('uncertain_audio', frames);
      this.resetTurn();
      return null;
    }
    const activeMs = frames.length * this.options.frameMs;
    const dominant = Object.keys(turn.styles).reduce((a, b) => turn.styles[a] >= turn.styles[b] ? a : b);
    const meanPower = mean(frames.map(f => f.rms ** 2));
    const pitches = frames.filter(f => f.pitchHz && f.periodicity >= 0.65).map(f => f.pitchHz);
    const payload = {
      schema_version: '1.0', event: 'user_turn_complete',
      session_id: this.sessionId, turn_id: turn.id,
      timing: { start_ms: turn.startMs, end_ms: turn.lastActiveMs,
        duration_ms: turn.lastActiveMs - turn.startMs, active_audio_ms: activeMs,
        end_reason: reason, continues: continued },
      transcript: turn.transcript,
      speech_evidence: { source: turn.transcript ? 'acoustic_heuristics_and_asr' : 'acoustic_heuristics',
        words_available: Boolean(turn.transcript),
        speech_confirmed_by_asr: Boolean(turn.transcript?.is_final),
        certainty: dominant === 'voiced_speech' ? 'medium' : 'low' },
      prosody_analysis: {
        dominant_style: dominant,
        style_duration_ms: { ...turn.styles },
        average_rms_dbfs: rounded(db(Math.sqrt(meanPower))),
        peak_dbfs: rounded(Math.max(...frames.map(f => f.peakDbfs))),
        signal_above_noise_db: rounded(db(Math.sqrt(meanPower)) - this.noiseDb),
        voiced_fraction: rounded(frames.filter(f => f.periodicity >= 0.65).length / frames.length, 3),
        median_pitch_hz: pitches.length ? rounded(quantile(pitches, 0.5), 1) : null,
      },
      quality: { noise_floor_dbfs: rounded(this.noiseDb),
        clipped: frames.some(f => f.clippedFraction > 0.01),
        possible_non_speech: dominant !== 'voiced_speech',
        emotion_inferred: false },
      llm_guidance: 'Use prosody as tentative delivery context, not emotion or intent. Whisper-like audio may be breath/noise. Never invent words when transcript is null. Do not interpret loudness alone as anger or urgency.',
    };
    this.resetTurn();
    this.onTurn(payload);
    return payload;
  }

  report(state, f) {
    const value = {
      state, turn_id: this.turn?.id || null, audio_time_ms: this.timeMs,
      level_dbfs: rounded(f.dbfs), noise_floor_dbfs: rounded(this.noiseDb),
      pitch_hz: f.pitchHz ? rounded(f.pitchHz, 1) : null,
      periodicity: rounded(f.periodicity, 3),
      calibration_failed: this.calibrationFailed,
    };
    this.onFrame(value);
    return value;
  }
}

const WORKLET_SOURCE = `
class EchoSphereCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(Math.round(sampleRate * 0.05));
    this.position = 0;
    this.port.onmessage = ({data}) => {
      if (data === 'flush') {
        // Pad only the final partial frame; full frames always contain 50 ms.
        if (this.position) this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(Math.round(sampleRate * 0.05));
        this.position = 0;
        this.port.postMessage({ flushed: true });
      }
    };
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    if (input) for (let i = 0; i < input.length; i++) {
      this.buffer[this.position++] = input[i];
      if (this.position === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(Math.round(sampleRate * 0.05));
        this.position = 0;
      }
    }
    // Capture only. Do not send microphone audio to the speakers.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    return true;
  }
}
registerProcessor('echosphere-capture', EchoSphereCapture);
`;

// Compatibility path for browsers that cannot load an AudioWorklet (notably
// local-file pages). Keep contiguous 50 ms frames; never monitor the mic.
function createCompatibilityCapture(context, onFrame) {
  if (!context.createScriptProcessor) throw new Error('Audio processing is unavailable. Launch Start EchoSphere.cmd and use a current browser.');
  const node = context.createScriptProcessor(2048, 1, 1);
  let buffer = new Float32Array(Math.round(context.sampleRate * 0.05));
  let position = 0;
  const flush = () => {
    if (position) onFrame(buffer);
    buffer = new Float32Array(buffer.length); position = 0;
  };
  node.onaudioprocess = event => {
    const input = event.inputBuffer.getChannelData(0);
    for (let offset = 0; offset < input.length;) {
      const length = Math.min(input.length - offset, buffer.length - position);
      buffer.set(input.subarray(offset, offset + length), position);
      position += length; offset += length;
      if (position === buffer.length) flush();
    }
    for (let i = 0; i < event.outputBuffer.numberOfChannels; i++) event.outputBuffer.getChannelData(i).fill(0);
  };
  return { node, flush, close() { node.onaudioprocess = null; node.disconnect(); } };
}

// Explicit acknowledgement prevents displaying "sent" for a logged payload.
// Failed turns stay at the head of the queue; retries preserve the turn ID.
class TurnDispatcher {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.queue = [];
    this.handler = null;
    this.running = false;
    this.failed = false;
  }
  enqueue(payload) {
    this.queue.push(JSON.parse(JSON.stringify(payload)));
    this.onStatus({ state: this.handler ? 'queued' : 'not_connected', pending: this.queue.length });
    void this.drain();
  }
  setHandler(handler) {
    if (handler !== null && typeof handler !== 'function') throw new TypeError('Handler must be a function or null.');
    this.handler = handler;
    this.failed = false;
    return this.drain();
  }
  retry() { this.failed = false; return this.drain(); }
  async drain() {
    if (this.running || this.failed || !this.handler) return;
    this.running = true;
    try {
      while (this.queue.length && this.handler) {
        const payload = this.queue[0];
        this.onStatus({ state: 'sending', turn_id: payload.turn_id, pending: this.queue.length });
        try {
          // Do not let a consumer mutate the copy retained for a possible retry.
          await this.handler(JSON.parse(JSON.stringify(payload)));
          this.queue.shift();
          this.onStatus({ state: 'delivered', turn_id: payload.turn_id, pending: this.queue.length });
        } catch (error) {
          this.failed = true;
          this.onStatus({ state: 'failed', turn_id: payload.turn_id, pending: this.queue.length,
            message: error instanceof Error ? error.message : String(error) });
          break;
        }
      }
    } finally { this.running = false; }
  }
}

function createLocalJsonHandler({ url, timeoutMs = 20000 }) {
  const endpoint = new URL(url);
  if (!['http:', 'https:'].includes(endpoint.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password) {
    throw new Error('Use a loopback HTTP(S) endpoint for local JSON delivery.');
  }
  return async payload => {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Local endpoint returned HTTP ${response.status}`);
  };
}

// Offline narrative is deliberately scripted and labelled, never presented as an LLM.
class OfflineStory {
  constructor() { this.turns = 0; }
  reply(payload) {
    this.turns++;
    const words = payload.transcript?.text?.toLowerCase() || '';
    if (words.includes('left')) return 'You take the left corridor. A low mechanical hum grows clearer, and a blue lamp reveals a door marked OBSERVATORY. You can open the door or listen at the wall.';
    if (words.includes('right')) return 'The right corridor leads to a rain-dark courtyard. A bell moves without ringing. Beneath it, a narrow stair descends into warm light.';
    if (words.includes('open') || words.includes('door')) return 'The observatory door opens. A guide waits beside a map of moving stars. “We have been listening,” she says. “Which path will you choose?”';
    if (words.includes('listen')) return 'You pause to listen. Water taps somewhere to your left; a steady hum answers from the right. Neither sound gives away its source.';
    if (payload.prosody_analysis?.dominant_style === 'whisper_like') return 'The soundscape draws close: a soft rustle on the left, a distant chime on the right. Your guide lowers her voice. “There are two passages ahead. Take your time.”';
    if (payload.prosody_analysis?.dominant_style === 'voiced_speech') return 'Your voice carries through the stone hall. The room answers with a deeper resonance, and two passages come into focus. Your guide waits for you to choose left or right.';
    return this.turns === 1 ? 'You stand at the entrance to an abandoned observatory. Two passages open ahead. Type “left”, “right”, or “listen” to explore the scripted scene, or speak to change its atmosphere.' : 'The observatory holds its breath. Your guide waits beside the two passages. You can go left, go right, or listen.';
  }
}

function sceneControls(frame) {
  const active = ['voiced_speech', 'whisper_like', 'uncertain_audio', 'candidate'].includes(frame.state);
  const intensity = active ? Math.min(1, Math.max(0, (frame.level_dbfs + 65) / 45)) : 0.12;
  return { intensity, pan: frame.state === 'whisper_like' ? -0.65 : frame.state === 'voiced_speech' ? 0.65 : 0,
    filterHz: 250 + intensity * 1500, gain: 0.012 + intensity * 0.025 };
}

class SceneAudio {
  constructor() { this.context = null; }
  async enable() {
    if (this.context) return;
    const context = new AudioContext();
    this.context = context;
    let timer;
    try {
      await Promise.race([context.resume(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Ambient audio startup timed out.')), 5000);
      })]);
      clearTimeout(timer);
      const tone = context.createOscillator();
      tone.type = 'sine'; tone.frequency.value = 110;
      const overtone = context.createOscillator();
      overtone.type = 'sine'; overtone.frequency.value = 164.81;
      const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 400;
      const panner = context.createStereoPanner();
      const gain = context.createGain(); gain.gain.value = 0.015;
      tone.connect(filter); overtone.connect(filter); filter.connect(panner); panner.connect(gain); gain.connect(context.destination);
      tone.start(); overtone.start();
      this.nodes = { tone, overtone, filter, panner, gain };
    } catch (error) { await this.disable(); throw error; }
    finally { clearTimeout(timer); }
  }
  update(controls) {
    if (!this.nodes || !this.context) return;
    const time = this.context.currentTime;
    this.nodes.filter.frequency.setTargetAtTime(controls.filterHz, time, 0.15);
    this.nodes.panner.pan.setTargetAtTime(controls.pan, time, 0.2);
    this.nodes.gain.gain.setTargetAtTime(controls.gain, time, 0.2);
  }
  async disable() {
    const context = this.context;
    this.context = null; this.nodes = null;
    if (context && context.state !== 'closed') await context.close();
  }
}

// Repeatable feature fixtures for a labelled, microphone-free signal tour.
// These are synthetic acoustic features, not recorded speech or accuracy claims.
function tourFrame(kind, index) {
  const quiet = { frameMs: 50, dbfs: -80, rms: 0.0001, peakDbfs: -75, crestDb: 5, periodicity: 0,
    pitchHz: null, clippedFraction: 0, lowRatio: 0.1, speechBandRatio: 0.8, highRatio: 0.4, flatness: 0.4, zeroCrossingsPerSecond: 5000 };
  if (index < 24 || index >= (kind === 'snap' ? 25 : 60)) return quiet;
  if (kind === 'snap') return { ...quiet, dbfs: -14, rms: 0.2, peakDbfs: 0, crestDb: 14 };
  const voiced = kind === 'speech';
  const dbfs = (voiced ? -27 : -43) + Math.sin(index * 1.1) * 6;
  return { ...quiet, dbfs, rms: 10 ** (dbfs / 20), peakDbfs: dbfs + 6,
    periodicity: voiced ? 0.9 : 0.15, pitchHz: voiced ? 160 : null, flatness: 0.3 };
}

// Dependency-free 3D projection: four orbit planes, depth-sorted electrons and
// a draggable global rotation. Acoustic frames modulate the animation locally.
class AtomExperience {
  constructor({ stars, atom, waveform }) {
    this.stars = stars; this.atom = atom; this.waveform = waveform;
    this.rotation = { x: -0.35, y: 0.3 };
    this.energy = 0; this.target = 0; this.active = false; this.phase = 0;
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.drag = null;
    this.starPoints = Array.from({ length: 260 }, () => ({ x: Math.random(), y: Math.random(), size: 0.3 + Math.random() * 1.3,
      brightness: 0.2 + Math.random() * 0.6, phase: Math.random() * Math.PI * 2, twinkle: Math.random() > 0.88 }));
    this.shells = [
      { radius: 65, tilt: 0.4, turn: 0.2, count: 2, color: '#f3c7ff' },
      { radius: 94, tilt: 1.05, turn: 0.65, count: 8, color: '#a1caff' },
      { radius: 124, tilt: 1.6, turn: -0.4, count: 18, color: '#b7a0ff' },
      { radius: 155, tilt: 0.85, turn: -1.0, count: 32, color: '#76e6ff' },
    ];
    atom.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      this.drag = { x: event.clientX, y: event.clientY }; atom.setPointerCapture(event.pointerId);
      atom.classList.add('dragging');
    });
    atom.addEventListener('pointermove', event => {
      if (!this.drag) return;
      this.rotation.y += (event.clientX - this.drag.x) * 0.008;
      this.rotation.x += (event.clientY - this.drag.y) * 0.008;
      this.drag = { x: event.clientX, y: event.clientY };
    });
    const endDrag = () => { this.drag = null; atom.classList.remove('dragging'); };
    atom.addEventListener('pointerup', endDrag); atom.addEventListener('pointercancel', endDrag);
    atom.addEventListener('lostpointercapture', endDrag);
    atom.addEventListener('keydown', event => {
      const keys = { ArrowLeft: [0, -0.12], ArrowRight: [0, 0.12], ArrowUp: [-0.12, 0], ArrowDown: [0.12, 0], Home: null };
      if (!(event.key in keys)) return;
      event.preventDefault();
      if (event.key === 'Home') this.rotation = { x: -0.35, y: 0.3 };
      else { this.rotation.x += keys[event.key][0]; this.rotation.y += keys[event.key][1]; }
    });
    this.last = performance.now();
    const animate = now => {
      const elapsed = Math.min((now - this.last) / 1000, 0.06); this.last = now;
      if (!document.hidden) {
        this.energy += (this.target - this.energy) * 0.12;
        if (!this.reducedMotion) this.phase += elapsed * (0.32 + this.energy * 1.5);
        this.drawStars(now / 1000); this.drawAtom(); this.drawWave(now / 1000);
      }
      this.animation = requestAnimationFrame(animate);
    };
    this.animation = requestAnimationFrame(animate);
  }
  react(frame) {
    this.target = ['silence', 'pause', 'calibrating', 'calibration_needed'].includes(frame.state) ? 0
      : Math.max(0, Math.min(1, (frame.level_dbfs + 65) / 45));
  }
  setActive(value) { this.active = value; if (!value) this.target = 0; }
  getState() { return { shells: 4, electrons: 60, rotation: { ...this.rotation }, energy: this.energy, active: this.active }; }
  surface(canvas) {
    const { width, height } = canvas.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(width * ratio), pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
    return { context, width, height };
  }
  drawStars(time) {
    const { context: ctx, width, height } = this.surface(this.stars);
    for (const star of this.starPoints) {
      const pulse = star.twinkle && !this.reducedMotion ? 0.6 + Math.sin(time * 0.8 + star.phase) * 0.4 : 1;
      ctx.fillStyle = `rgba(219,230,255,${star.brightness * pulse})`;
      ctx.beginPath(); ctx.arc(star.x * width, star.y * height, star.size, 0, Math.PI * 2); ctx.fill();
      if (star.twinkle && pulse > 0.86) {
        ctx.strokeStyle = `rgba(200,218,255,${(pulse - 0.86) * 1.5})`; ctx.lineWidth = 0.6;
        const x = star.x * width, y = star.y * height;
        ctx.beginPath(); ctx.moveTo(x - 4, y); ctx.lineTo(x + 4, y); ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4); ctx.stroke();
      }
    }
  }
  rotate(point, xAngle, yAngle) {
    const [x, y, z] = point;
    const y1 = y * Math.cos(xAngle) - z * Math.sin(xAngle), z1 = y * Math.sin(xAngle) + z * Math.cos(xAngle);
    return [x * Math.cos(yAngle) + z1 * Math.sin(yAngle), y1, -x * Math.sin(yAngle) + z1 * Math.cos(yAngle)];
  }
  orbit(shell, angle) {
    const radius = shell.radius * (1 + this.energy * 0.13);
    return this.rotate(this.rotate([Math.cos(angle) * radius, Math.sin(angle) * radius, 0], shell.tilt, shell.turn), this.rotation.x, this.rotation.y);
  }
  drawAtom() {
    const { context: ctx, width, height } = this.surface(this.atom);
    const size = Math.min(width, height) / 390;
    const project = ([x, y, z]) => { const depth = 600 / (600 - z); return { x: width / 2 + x * size * depth, y: height / 2 + y * size * depth, z, scale: size * depth }; };
    const items = [];
    this.shells.forEach((shell, index) => {
      for (let step = 0; step < 144; step++) {
        const a = project(this.orbit(shell, step / 144 * Math.PI * 2));
        const b = project(this.orbit(shell, (step + 1) / 144 * Math.PI * 2));
        items.push({ type: 'line', a, b, z: (a.z + b.z) / 2, color: shell.color });
      }
      for (let electron = 0; electron < shell.count; electron++) {
        const angle = electron / shell.count * Math.PI * 2 + this.phase * (index % 2 ? -1 : 1) * (1.4 - index * 0.18);
        const point = project(this.orbit(shell, angle));
        items.push({ type: 'electron', ...point, color: shell.color, radius: 2.1 + (3 - index) * 0.25 });
      }
    });
    // Small spatial cluster at the nucleus, rather than a flat centre icon.
    for (let i = 0; i < 18; i++) {
      const theta = i * 2.39996, vertical = 1 - 2 * (i + 0.5) / 18;
      const r = Math.sqrt(1 - vertical * vertical) * 15;
      const point = project(this.rotate([Math.cos(theta) * r, Math.sin(theta) * r, vertical * 15], this.rotation.x, this.rotation.y));
      items.push({ type: 'nucleus', ...point, color: i % 2 ? '#c7a7ff' : '#f2bce9', radius: 6 });
    }
    const glow = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, 100 * size);
    glow.addColorStop(0, `rgba(127,106,255,${0.17 + this.energy * 0.15})`); glow.addColorStop(1, 'rgba(127,106,255,0)');
    ctx.fillStyle = glow; ctx.fillRect(0, 0, width, height);
    items.sort((a, b) => a.z - b.z);
    for (const item of items) {
      if (item.type === 'line') {
        ctx.globalAlpha = item.z < 0 ? 0.2 : 0.52; ctx.strokeStyle = item.color;
        ctx.lineWidth = size * (0.8 + this.energy * 0.8);
        ctx.beginPath(); ctx.moveTo(item.a.x, item.a.y); ctx.lineTo(item.b.x, item.b.y); ctx.stroke();
      } else {
        ctx.globalAlpha = item.z < 0 ? 0.7 : 1;
        ctx.fillStyle = item.color; ctx.shadowColor = item.color; ctx.shadowBlur = (item.type === 'electron' ? 10 : 13) * size;
        ctx.beginPath(); ctx.arc(item.x, item.y, item.radius * item.scale * (1 + this.energy * 0.25), 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
    ctx.globalAlpha = 1;
  }
  drawWave(time) {
    const { context: ctx, width, height } = this.surface(this.waveform);
    ctx.strokeStyle = '#e4ddff'; ctx.lineWidth = 1.5; ctx.shadowColor = '#b2a0ff'; ctx.shadowBlur = 8;
    ctx.beginPath();
    for (let x = 0; x <= width; x += 2) {
      const envelope = Math.sin(x / width * Math.PI) ** 1.8;
      const movement = this.reducedMotion ? 0 : time * (2 + this.energy * 3);
      const wave = Math.sin(x * 0.095 - movement) * Math.sin(x * 0.032 + movement * 0.4);
      const y = height / 2 + wave * envelope * (5 + this.energy * 17);
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.shadowBlur = 0;
  }
  destroy() { cancelAnimationFrame(this.animation); }
}


const $ = id => document.getElementById(id);
const visuals = new AtomExperience({ stars: $('starfield'), atom: $('atomCanvas'), waveform: $('voiceWave') });
const labels = {
  calibrating: 'Calibrating — stay quiet', calibration_needed: 'Calibration failed — restart in a quiet room',
  candidate: 'Listening to onset…', voiced_speech: 'Voiced speech', whisper_like: 'Whisper-like (tentative)',
  uncertain_audio: 'Uncertain audio', transient: 'Brief transient', pause: 'Pause — holding turn', silence: 'Listening',
};
let context, stream, source, capture, engine;
let running = false, starting = false, stopping = false, lastPayload = null;
let flushResolve = null;
let compatibilityCapture = null, captureMode = null, startupController = null;
let frameCount = 0, lastAudioAt = 0, captureWatchdog = null;
let diagnostic = {};
let setupToken = null, setupPending = false;

function showDiagnostic(values) {
  diagnostic = { ...diagnostic, ...values };
  $('micDiagnostics').textContent = JSON.stringify(diagnostic, null, 2);
}

function bounded(promise, milliseconds, message, signal) {
  return new Promise((resolve, reject) => {
    const finish = (fn, value) => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); fn(value); };
    const cancel = () => finish(reject, new DOMException('Microphone request cancelled.', 'AbortError'));
    const timer = setTimeout(() => finish(reject, new Error(message)), milliseconds);
    signal?.addEventListener('abort', cancel, { once: true });
    promise.then(value => finish(resolve, value), error => finish(reject, error));
    if (signal?.aborted) cancel();
  });
}
let lastFrameState = null;
let queuedTurns = 0;
let transportState = 'not_connected';
let agentReady = false;
let connectionPending = false;
let spokenReply = '';
let narrativeMode = 'waiting';
let tourActive = false;
let lastVibration = 0;
const offlineStory = new OfflineStory();
const sceneAudio = new SceneAudio();
const textSession = crypto.randomUUID();

function setNarrativeMode(mode, help) {
  narrativeMode = mode;
  $('modeBadge').textContent = { live: 'Live · Evolus agent', offline: 'Offline · scripted scene', waiting: 'Narration needs setup' }[mode];
  $('modeBadge').dataset.mode = mode;
  $('modeHelp').textContent = help;
}

function useOfflineScene() {
  setNarrativeMode('offline', 'Offline mode uses a scripted local scene, not an LLM. Your microphone and text stay on this device.');
  void dispatcher.setHandler(async payload => {
    const reply = offlineStory.reply(payload);
    showReply(reply, 'Offline scripted scene · no LLM');
    window.dispatchEvent(new CustomEvent('echosphere:response', { detail: { turn_id: payload.turn_id, reply, source: 'offline_script' } }));
  });
  if (!lastPayload) showReply(offlineStory.reply({ transcript: null }), 'Offline scripted scene · no LLM');
  $('deliveryStatus').textContent = 'Offline scene ready. Speak, whisper, or type a story action.';
}


const dispatcher = new TurnDispatcher(status => {
  transportState = status.state;
  queuedTurns = status.pending;
  const messages = {
    not_connected: `Choose live narration or Try offline scene to respond to your audio (${status.pending} queued).`,
    queued: `Queued for narration (${status.pending}).`, sending: `Sending ${status.turn_id}…`,
    delivered: `Narrative response received. ${status.pending} queued.`,
    failed: `Delivery failed; turn kept for retry: ${status.message}`,
  };
  $('deliveryStatus').textContent = messages[status.state];
  $('retryBtn').disabled = status.state !== 'failed';
});

function logPayload(payload) {
  lastPayload = payload;
  $('jsonLog').textContent = JSON.stringify(payload, null, 2);
  $('downloadBtn').disabled = false;
}

function onTurn(payload) {
  logPayload(payload);
  window.dispatchEvent(new CustomEvent('echosphere:turn', { detail: structuredClone(payload) }));
  dispatcher.enqueue(payload);
  if (queuedTurns >= 100) {
    $('notice').textContent = '100 turns are queued without delivery. Capture stopped to avoid an unbounded queue; connect your handler or reload to start a new session.';
    void stop();
  }
}

function onFrame(frame) {
  visuals.react(frame);
  const controls = sceneControls(frame);
  sceneAudio.update(controls);
  $('sceneStatus').textContent = `Scene intensity: ${Math.round(controls.intensity * 100)}% · stereo position: ${controls.pan < 0 ? 'left' : controls.pan > 0 ? 'right' : 'centre'}. ${sceneAudio.context ? 'Ambient audio on.' : 'Sound off.'}`;
  if ($('hapticsToggle').checked && navigator.vibrate && controls.intensity > 0.35 && performance.now() - lastVibration > 600) {
    navigator.vibrate(Math.round(15 + controls.intensity * 35)); lastVibration = performance.now();
  }
  $('inputMeter').value = Math.max(-100, frame.level_dbfs);
  if (lastFrameState !== frame.state) {
    $('turnStateVal').textContent = labels[frame.state];
    $('heroStatus').textContent = tourActive ? 'Synthetic signal preview · microphone off'
      : `${labels[frame.state]} · ${narrativeMode === 'live' ? 'Live narration ready' : narrativeMode === 'offline' ? 'Offline scene ready' : 'Choose narration in Story & controls'}`;
    lastFrameState = frame.state;
  }
  $('moodVal').textContent = frame.state === 'pause' ? 'Holding previous style' : labels[frame.state];
  $('levelVal').textContent = `${frame.level_dbfs.toFixed(1)} dBFS`;
  $('noiseVal').textContent = `${frame.noise_floor_dbfs.toFixed(1)} dBFS`;
  $('pitchVal').textContent = frame.pitch_hz === null ? 'Unvoiced / unknown' : `${frame.pitch_hz.toFixed(0)} Hz (estimate)`;
  window.dispatchEvent(new CustomEvent('echosphere:frame', { detail: frame }));
  if (frame.calibration_failed) {
    $('notice').textContent = 'Calibration contained speech, bursts, or excessive noise. Stop and start again; remain quiet during the first 1.2 seconds.';
  }
}

function newEngine() {
  return new AudioEngine({ onFrame, onTurn, onEvent(payload) {
    logPayload(payload);
    window.dispatchEvent(new CustomEvent('echosphere:audio-event', { detail: structuredClone(payload) }));
  } });
}

async function refreshMicrophones() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const selected = $('microphoneSelect').value;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput');
    $('microphoneSelect').replaceChildren(new Option('System default microphone', ''));
    devices.forEach((device, index) => $('microphoneSelect').add(new Option(device.label || `Microphone ${index + 1}`, device.deviceId)));
    if (devices.some(device => device.deviceId === selected)) $('microphoneSelect').value = selected;
  } catch { $('notice').textContent = 'Microphone list unavailable. Start with the system default, or check browser permission.'; }
}

async function start() {
  if (running || starting || stopping || tourActive) return;
  if (queuedTurns >= 100) {
    $('notice').textContent = 'Deliver the queued turns or reload before starting another capture.';
    return;
  }
  starting = true;
  const controller = new AbortController(); startupController = controller;
  const signal = controller.signal;
  let stage = 'browser support', permissionTimer;
  frameCount = 0; captureMode = null; diagnostic = {};
  $('startBtn').textContent = 'Cancel microphone request';
  $('initializeLabel').textContent = 'Cancel microphone request';
  $('heroStatus').textContent = 'Allow microphone access. Stay quiet for the first 1.2 seconds.';
  $('microphoneSelect').disabled = true;
  $('notice').textContent = 'Allow microphone access, then remain quiet for 1.2 seconds.';
  $('micStatus').textContent = 'Waiting for microphone permission…';
  showDiagnostic({ page: location.protocol === 'file:' ? 'local file' : location.origin, secure_context: isSecureContext });
  try {
    window.speechSynthesis?.cancel();
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Launch Start EchoSphere.cmd and use the page it opens. Microphone capture needs a local server or HTTPS.');
    if (!window.AudioContext) throw new Error('Use a current Edge, Chrome, Firefox, or Safari browser.');
    context = new AudioContext();
    const resumed = context.resume().then(() => null, error => error);
    stage = 'opening microphone';
    permissionTimer = setTimeout(() => {
      $('notice').textContent = 'Waiting for permission. Check the microphone icon in the address bar, or cancel and try again.';
    }, 10000);
    const selected = $('microphoneSelect').value;
    const acquire = async audio => {
      const pending = navigator.mediaDevices.getUserMedia({ audio });
      // Permission can resolve after cancellation/timeout; always close that stream.
      pending.then(value => { if (signal.aborted) value.getTracks().forEach(track => track.stop()); }, () => {});
      return bounded(pending, 30000, 'Microphone permission timed out. Check the browser prompt, then try again.', signal);
    };
    try {
      stream = await acquire({ channelCount: { ideal: 1 }, autoGainControl: false, noiseSuppression: false,
        echoCancellation: true, ...(selected ? { deviceId: { exact: selected } } : {}) });
    } catch (error) {
      if (signal.aborted || !['AbortError', 'OverconstrainedError'].includes(error.name)) throw error;
      showDiagnostic({ device_retry: 'Retrying with browser-default audio processing' });
      stream = await acquire(selected ? { deviceId: { exact: selected } } : true);
    }
    clearTimeout(permissionTimer);
    stage = 'resuming browser audio';
    $('micStatus').textContent = 'Starting audio capture…';
    const resumeError = await bounded(resumed, 5000, 'Browser audio did not start. Launch the full app and check your audio output device.', signal);
    if (resumeError) throw resumeError;
    engine = newEngine();
    const receive = data => {
      if (!running) return;
      frameCount++; lastAudioAt = performance.now();
      try { engine.process(data, context.sampleRate); }
      catch (error) {
        showDiagnostic({ error_stage: 'analysing audio', error_name: error.name, error_message: error.message });
        $('notice').textContent = 'Audio analysis failed. See Microphone diagnostics and restart capture.';
        void stop();
      }
    };
    stage = 'loading audio processor';
    if (context.audioWorklet && location.protocol !== 'file:') {
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
      try {
        await bounded(context.audioWorklet.addModule(url), 5000, 'AudioWorklet loading timed out.', signal);
        capture = new AudioWorkletNode(context, 'echosphere-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        capture.port.onmessage = ({ data }) => { if (data.flushed) flushResolve?.(); else receive(data); };
        capture.onprocessorerror = () => {
          showDiagnostic({ error_stage: 'audio processor', error_message: 'AudioWorklet stopped unexpectedly' });
          $('notice').textContent = 'Audio processing stopped. Restart the microphone.';
          void stop();
        };
        captureMode = 'AudioWorklet';
      } catch (error) {
        if (signal.aborted) throw error;
        showDiagnostic({ worklet_error: `${error.name}: ${error.message}`, fallback: 'Compatibility capture' });
      } finally { URL.revokeObjectURL(url); }
    }
    if (!capture) {
      compatibilityCapture = createCompatibilityCapture(context, receive);
      capture = compatibilityCapture.node;
      captureMode = 'Compatibility';
    }
    stage = 'connecting microphone';
    source = context.createMediaStreamSource(stream);
    running = true; lastAudioAt = performance.now();
    source.connect(capture); capture.connect(context.destination);
    const track = stream.getAudioTracks()[0];
    showDiagnostic({ capture_mode: captureMode, sample_rate: context.sampleRate, device: track?.label || 'System default', audio_context: context.state });
    context.onstatechange = () => {
      if (running && !stopping && context.state !== 'running') $('notice').textContent = 'Browser audio paused. Stop and start the microphone to resume.';
    };
    for (const track of stream.getAudioTracks()) track.onended = () => {
      $('notice').textContent = 'The microphone disconnected. Reconnect it, then start again.';
      void stop();
    };
    captureWatchdog = setInterval(() => {
      if (running && performance.now() - lastAudioAt > 4000) {
        showDiagnostic({ error_stage: 'receiving audio', error_message: 'No audio frames for 4 seconds' });
        $('notice').textContent = 'No audio frames arrived. Select another microphone and start again.';
        void stop();
      }
    }, 1000);
    $('startBtn').textContent = 'Stop microphone';
    visuals.setActive(true);
    $('initializeLabel').textContent = 'Listening. Click to Pause.';
    $('heroStatus').textContent = 'Calibrating for 1.2 seconds, then your voice moves the orbits.';
    $('recalibrateBtn').disabled = false;
    $('notice').textContent = 'Stay quiet for calibration. Then speak or whisper naturally. Use headphones when your narrative engine plays audio.';
    $('micStatus').textContent = `Microphone active · ${captureMode === 'Compatibility' ? 'compatibility mode · ' : ''}analysis on this device`;
    void refreshMicrophones();
  } catch (error) {
    const cancelled = signal.aborted;
    controller.abort();
    const hints = {
      NotAllowedError: 'Allow Microphone in the browser’s site controls and Windows microphone privacy settings, then try again.',
      NotFoundError: 'No microphone was found. Connect one or choose another input.',
      NotReadableError: 'Close other apps using the microphone and check your system’s audio input.',
      AbortError: 'The audio device did not start. Choose another microphone, close apps using it, and launch Start EchoSphere.cmd.',
    };
    showDiagnostic({ error_stage: stage, error_name: error.name, error_message: error.message });
    $('notice').textContent = cancelled ? 'Microphone request cancelled. You can try again.'
      : `Could not start (${stage}): ${hints[error.name] || error.message}`;
    running = false;
    await releaseAudio();
    $('micStatus').textContent = 'Microphone off';
    $('startBtn').textContent = 'Start microphone';
    visuals.setActive(false);
    $('initializeLabel').textContent = 'Click to Initialize.';
    $('heroStatus').textContent = $('notice').textContent;
  } finally {
    clearTimeout(permissionTimer);
    starting = false; startupController = null;
    $('startBtn').disabled = false;
    $('microphoneSelect').disabled = running;
  }
}

async function releaseAudio() {
  clearInterval(captureWatchdog); captureWatchdog = null;
  source?.disconnect();
  compatibilityCapture?.close();
  capture?.disconnect();
  if (capture?.port) capture.port.onmessage = null;
  if (capture) capture.onprocessorerror = null;
  stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
  if (context && context.state !== 'closed') {
    context.onstatechange = null;
    await bounded(context.close(), 1500, 'Audio context cleanup timed out.').catch(() => {});
  }
  source = null; capture = null; stream = null; context = null; compatibilityCapture = null;
}

async function stop() {
  if (stopping || !running) return;
  stopping = true;
  $('startBtn').disabled = true;
  source?.disconnect();
  // Finish PCM already captured before closing the context.
  if (compatibilityCapture) compatibilityCapture.flush();
  else if (capture && context?.state === 'running') {
    await new Promise(resolve => {
      const timeout = setTimeout(() => { flushResolve = null; resolve(); }, 300);
      flushResolve = () => { clearTimeout(timeout); flushResolve = null; resolve(); };
      capture.port.postMessage('flush');
    });
  }
  running = false;
  engine?.finish('manual_stop');
  await releaseAudio();
  lastFrameState = null;
  $('startBtn').textContent = 'Start microphone';
  visuals.setActive(false);
  $('initializeLabel').textContent = 'Click to Initialize.';
  $('heroStatus').textContent = 'Microphone paused. Click to begin again.';
  $('startBtn').disabled = false;
  $('turnStateVal').textContent = 'Stopped';
  $('moodVal').textContent = '—';
  $('micStatus').textContent = 'Microphone off';
  $('microphoneSelect').disabled = false;
  $('recalibrateBtn').disabled = true;
  $('inputMeter').value = -100;
  showDiagnostic({ frames_received: frameCount });
  if ($('notice').textContent.startsWith('Stay quiet for calibration.')) {
    $('notice').textContent = 'Microphone stopped. Start again to recalibrate for a new session.';
  }
  stopping = false;
}

$('startBtn').addEventListener('click', () => starting ? startupController?.abort() : running ? void stop() : void start());
$('initializeBtn').addEventListener('click', () => starting ? startupController?.abort() : running ? void stop() : void start());
$('devicesBtn').addEventListener('click', () => void refreshMicrophones());
$('recalibrateBtn').addEventListener('click', async () => { await stop(); await start(); });
$('retryBtn').addEventListener('click', () => void dispatcher.retry());
$('connectBtn').addEventListener('click', () => void connectEvolus());
$('speakBtn').addEventListener('click', () => void speakReply());
$('downloadBtn').addEventListener('click', () => {
  if (!lastPayload) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(lastPayload, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = 'echosphere-payload.json'; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener('pagehide', () => { stream?.getTracks().forEach(track => track.stop()); void sceneAudio.disable(); navigator.vibrate?.(0); });

async function connectEvolus({ selectLive = true } = {}) {
  if (connectionPending) return false;
  if (!['http:', 'https:'].includes(location.protocol)) {
    $('launchHelp').hidden = false;
    $('agentStatus').textContent = 'The agent needs the local app. Double-click Start EchoSphere.cmd in the extracted folder.';
    $('connectBtn').disabled = true;
    if (narrativeMode !== 'offline') setNarrativeMode('waiting', 'Open the full app to connect Evolus, or choose Try offline scene to explore now.');
    return false;
  }
  connectionPending = true;
  $('connectBtn').disabled = true;
  $('agentStatus').textContent = 'Checking your local backend and EchoSphere agent…';
  try {
    const response = await fetch('/api/status', { signal: AbortSignal.timeout(20000) });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Launch Start EchoSphere.cmd or npm start and use the page it opens.');
    const status = await response.json();
    if (status.app !== 'EchoSphere') throw new Error('This page is not connected to the EchoSphere backend. Launch the full app.');
    setupToken = status.setup_token;
    $('agentSetup').hidden = status.setup_allowed === false;
    $('launchHelp').hidden = true;
    $('agentIdInput').value = status.agent_id;
    if (!status.configured) {
      $('agentSetup').open = status.setup_allowed !== false;
      throw new Error(status.error || 'Enter your Evolus key below to connect this computer.');
    }
    agentReady = true;
    $('testAgentBtn').disabled = false;
    $('agentStatus').textContent = status.live_connection_verified
      ? 'EchoSphere agent connected — a real response has been received.'
      : 'EchoSphere agent found. Test the connection or start speaking.';
    if (narrativeMode === 'offline' && !selectLive) return true;
    setNarrativeMode('live', 'Live narration is connected through the app backend. Audio stays on this device; turn JSON and typed text go to Evolus.');
    $('deliveryStatus').textContent = 'Live narration ready. Speak or type your next action.';
    // Attach the handler without blocking setup on previously queued turns.
    void dispatcher.setHandler(async payload => {
      const resultResponse = await fetch('/api/turn', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(75000),
      });
      const result = await resultResponse.json();
      if (!resultResponse.ok) throw new Error(result.error || `Backend returned HTTP ${resultResponse.status}`);
      if (result.turn_id !== payload.turn_id || typeof result.reply !== 'string') throw new Error('Unexpected agent response.');
      showReply(result.reply, 'Live Evolus agent');
      $('agentStatus').textContent = 'EchoSphere agent connected — response received.';
      window.dispatchEvent(new CustomEvent('echosphere:response', { detail: result }));
    });
    return true;
  } catch (error) {
    agentReady = false;
    $('testAgentBtn').disabled = true;
    if (narrativeMode !== 'offline') {
      void dispatcher.setHandler(null);
      setNarrativeMode('waiting', `Live narration unavailable: ${error.message} You can still explore the offline scene.`);
    }
    $('agentStatus').textContent = `Agent unavailable: ${error.message}`;
    if (!setupToken) $('launchHelp').hidden = false;
    return false;
  } finally {
    connectionPending = false;
    $('connectBtn').disabled = false;
  }
}

function showReply(reply, sourceLabel = 'Live Evolus agent') {
  $('replySource').textContent = sourceLabel;
  $('agentReply').textContent = reply;
  spokenReply = reply;
  $('speakBtn').disabled = false;
  $('heroStory').textContent = 'Your story has a new response. Read it below ↓';
}

async function testAgent() {
  if (!setupToken || !agentReady) return;
  $('testAgentBtn').disabled = true;
  $('agentTestStatus').textContent = 'Waiting for a real response from your Evolus agent…';
  try {
    const response = await fetch('/api/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EchoSphere-Token': setupToken },
      body: '{}', signal: AbortSignal.timeout(60000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Agent connection test failed.');
    showReply(result.reply);
    $('agentTestStatus').textContent = 'Connection verified: a real agent response is shown below. Microphone audio was not needed for this test.';
    $('agentStatus').textContent = 'EchoSphere agent connected — a real response has been received.';
  } catch (error) {
    $('agentTestStatus').textContent = `Connection test failed: ${error.message}`;
  } finally { $('testAgentBtn').disabled = !agentReady; }
}

$('testAgentBtn').addEventListener('click', () => void testAgent());
$('agentForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!setupToken || setupPending) return;
  setupPending = true; $('saveAgentBtn').disabled = true;
  $('setupStatus').textContent = 'Checking your key and agent access…';
  const apiKey = $('apiKeyInput').value.trim();
  $('apiKeyInput').value = '';
  try {
    const response = await fetch('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EchoSphere-Token': setupToken },
      body: JSON.stringify({ apiKey, agentId: $('agentIdInput').value.trim(), remember: $('rememberKey').checked }),
      signal: AbortSignal.timeout(25000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Agent configuration failed.');
    $('setupStatus').textContent = result.remembered ? 'Key saved on this computer.' : 'Key connected for this run. Re-enter it after restarting the server.';
    if (await connectEvolus()) {
      if (queuedTurns || dispatcher.running) $('agentTestStatus').textContent = 'Your queued audio is being delivered. Its response will verify the connection.';
      else await testAgent();
    }
  } catch (error) { $('setupStatus').textContent = `Could not connect: ${error.message}`; }
  finally { setupPending = false; $('saveAgentBtn').disabled = false; }
});

async function speakReply() {
  if (!spokenReply) return;
  const synth = window.speechSynthesis;
  if (!synth) { $('playbackStatus').textContent = 'This browser has no speech playback support.'; return; }
  const voices = synth.getVoices().filter(voice => voice.localService);
  const voice = voices.find(v => v.lang.startsWith('en')) || voices[0];
  if (!voice) {
    $('playbackStatus').textContent = 'No local voice is available in this browser. The response is shown above.';
    return;
  }
  // Playback is explicit, and capture stops so narration cannot become a user turn.
  if (running) await stop();
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(spokenReply);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  utterance.onend = () => { $('playbackStatus').textContent = 'Playback finished. Start the microphone when you are ready.'; };
  utterance.onerror = () => { $('playbackStatus').textContent = 'Playback failed. The response is still available as text.'; };
  $('playbackStatus').textContent = 'Playing locally. Microphone capture is paused.';
  synth.speak(utterance);
}

// Register an async handler that resolves only after your server accepts a turn.
// Keep adapters local. Do not enable browser SpeechRecognition implicitly:
// it can send microphone audio to a remote speech service.
window.echoSphere = Object.freeze({
  start, stop, connectEvolus,
  setTurnHandler: handler => dispatcher.setHandler(handler),
  connectLocalEndpoint: options => dispatcher.setHandler(createLocalJsonHandler(options)),
  retryDelivery: () => dispatcher.retry(),
  addTranscript: result => engine?.setTranscript(result) || false,
  getStatus: () => ({ visual: visuals.getState(), narrativeMode, tourActive, running, starting, captureMode, frameCount, diagnostic: structuredClone(diagnostic), agentReady, turnId: engine?.turn?.id || null, queuedTurns, transportState }),
});
$('startBtn').disabled = false;
$('initializeBtn').disabled = false;
$('heroStatus').textContent = 'Microphone stays off until you choose to begin.';
$('micStatus').textContent = 'Microphone off';
$('notice').textContent = 'Start in a quiet room and remain silent for 1.2 seconds to calibrate the noise floor.';
void connectEvolus({ selectLive: false });
void refreshMicrophones();

$('offlineBtn').addEventListener('click', useOfflineScene);
$('textForm').addEventListener('submit', event => {
  event.preventDefault();
  const text = $('storyText').value.trim();
  if (!text) return;
  if (narrativeMode === 'waiting') {
    $('modeHelp').textContent = 'Choose Try offline scene or connect live narration first, then send your text.';
    return;
  }
  if (queuedTurns >= 100) { $('modeHelp').textContent = 'Deliver or clear your queued turns before sending more text.'; return; }
  onTurn({ schema_version: '1.0', event: 'user_text', session_id: engine?.sessionId || textSession,
    turn_id: `text:${crypto.randomUUID()}`, transcript: { text, source: 'typed', is_final: true },
    prosody_analysis: null, llm_guidance: 'This is typed user input. No acoustic measurements or inferred emotion accompany it.' });
  $('storyText').value = '';
});
$('ambienceToggle').addEventListener('change', async event => {
  event.target.disabled = true;
  try { if (event.target.checked) await sceneAudio.enable(); else await sceneAudio.disable(); }
  catch { event.target.checked = false; $('sceneStatus').textContent = 'Ambient sound could not start. The text and microphone controls remain available.'; }
  finally { event.target.disabled = false; }
});
if (!navigator.vibrate) {
  $('hapticsToggle').disabled = true;
  $('hapticsToggle').parentElement.append(' — unavailable in this browser');
}
$('hapticsToggle').addEventListener('change', event => { if (!event.target.checked) navigator.vibrate?.(0); });
for (const button of document.querySelectorAll('.tourBtn')) button.addEventListener('click', async () => {
  if (running || starting || tourActive) { $('tourStatus').textContent = 'Stop microphone capture before running a signal tour.'; return; }
  tourActive = true; $('startBtn').disabled = true; $('initializeBtn').disabled = true;
  document.querySelectorAll('.tourBtn').forEach(el => { el.disabled = true; });
  $('tourStatus').textContent = 'Playing synthetic features through the detector. No microphone or LLM request is used.';
  let result;
  const detector = new AudioEngine({ onFrame, onTurn: payload => { result = payload; }, onEvent: payload => { result = payload; } });
  try {
    for (let i = 0; i < 80; i++) { detector.push(tourFrame(button.dataset.signal, i)); await new Promise(resolve => setTimeout(resolve, 50)); }
    detector.finish('tour_end');
    if (result) {
      logPayload({ ...result, demo_source: 'synthetic_feature_fixture' });
      $('tourStatus').textContent = `Synthetic tour result: ${result.prosody_analysis?.dominant_style || result.audio_type || result.event}. No LLM request was made.`;
    } else $('tourStatus').textContent = 'Tour complete. No speech turn was emitted.';
  } finally {
    tourActive = false; $('startBtn').disabled = false; $('initializeBtn').disabled = false;
    visuals.setActive(false); lastFrameState = null;
    $('heroStatus').textContent = 'Signal preview finished. Click to initialize your microphone.';
    document.querySelectorAll('.tourBtn').forEach(el => { el.disabled = false; });
    $('turnStateVal').textContent = 'Stopped';
  }
});

})();
