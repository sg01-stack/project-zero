// Offline narrative is deliberately scripted and labelled, never presented as an LLM.
export class OfflineStory {
  constructor() { this.turns = 0; }
  reply(payload) {
    this.turns++;
    if (payload.event === 'story_start') return 'Your guide whispers beside you at the doors of the abandoned observatory. Two passages glow ahead; tell me what catches your attention.';
    if (payload.event === 'story_continue') return 'A distant chime echoes across the observatory. Your guide waits nearby; you can follow the sound, look around, or ask her about it.';
    const words = payload.transcript?.text?.toLowerCase() || '';
    if (words.includes('whisper') && words.includes('beside')) return 'Your guide whispers beside you, keeping her voice low as you listen at the door. A faint rustle slips through the seam; she waits for your next move.';
    if (words.includes('distant') && words.includes('hall')) return 'A distant voice answers from the right, echoing across the great hall. “The telescope is still awake,” it calls, leaving you to decide whether to follow.';
    if (words.includes('left')) return 'You take the left corridor. A low mechanical hum grows clearer, and a blue lamp reveals a door marked OBSERVATORY. You can open the door or listen at the wall.';
    if (words.includes('right')) return 'The right corridor leads to a rain-dark courtyard. A bell moves without ringing. Beneath it, a narrow stair descends into warm light.';
    if (words.includes('open') || words.includes('door')) return 'The observatory door opens. A guide waits beside a map of moving stars. “We have been listening,” she says. “Which path will you choose?”';
    if (words.includes('listen')) return 'You pause to listen. Water taps somewhere to your left; a steady hum answers from the right. Neither sound gives away its source.';
    if (payload.prosody_analysis?.dominant_style === 'whisper_like') return 'The soundscape draws close: a soft rustle on the left, a distant chime on the right. Your guide lowers her voice. “There are two passages ahead. Take your time.”';
    if (payload.prosody_analysis?.dominant_style === 'voiced_speech') return 'Your voice carries through the stone hall. The room answers with a deeper resonance, and two passages come into focus. Your guide waits for you to choose left or right.';
    return this.turns === 1 ? 'You stand at the entrance to an abandoned observatory. Two passages open ahead. Type “left”, “right”, or “listen” to explore the scripted scene, or speak to change its atmosphere.' : 'The observatory holds its breath. Your guide waits beside the two passages. You can go left, go right, or listen.';
  }
}

export function sceneControls(frame) {
  const active = ['voiced_speech', 'whisper_like', 'uncertain_audio', 'candidate'].includes(frame.state);
  const intensity = active ? Math.min(1, Math.max(0, (frame.level_dbfs + 65) / 45)) : 0.12;
  return { intensity, pan: frame.state === 'whisper_like' ? -0.65 : frame.state === 'voiced_speech' ? 0.65 : 0,
    filterHz: 250 + intensity * 1500, gain: 0.012 + intensity * 0.025 };
}

export class SceneAudio {
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
export function tourFrame(kind, index) {
  const quiet = { frameMs: 50, dbfs: -80, rms: 0.0001, peakDbfs: -75, crestDb: 5, periodicity: 0,
    pitchHz: null, clippedFraction: 0, lowRatio: 0.1, speechBandRatio: 0.8, highRatio: 0.4, flatness: 0.4, zeroCrossingsPerSecond: 5000 };
  if (index < 24 || index >= (kind === 'snap' ? 25 : 60)) return quiet;
  if (kind === 'snap') return { ...quiet, dbfs: -14, rms: 0.2, peakDbfs: 0, crestDb: 14 };
  const voiced = kind === 'speech';
  const dbfs = (voiced ? -27 : -43) + Math.sin(index * 1.1) * 6;
  return { ...quiet, dbfs, rms: 10 ** (dbfs / 20), peakDbfs: dbfs + 6,
    periodicity: voiced ? 0.9 : 0.15, pitchHz: voiced ? 160 : null, flatness: 0.3 };
}
