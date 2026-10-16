// Dependency-free acoustic heuristics. Scores are evidence strengths, not
// calibrated probabilities; whispering vs breath/noise needs local ASR/VAD.
export const DEFAULTS = Object.freeze({
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

export function extractFeatures(input, sampleRate, frameMs = DEFAULTS.frameMs) {
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

export class AudioEngine {
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
