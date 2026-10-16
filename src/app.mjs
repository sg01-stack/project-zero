import { AudioEngine } from './audio-engine.mjs';
import { WORKLET_SOURCE, TurnDispatcher, createLocalJsonHandler } from './capture.mjs';

const $ = id => document.getElementById(id);
const labels = {
  calibrating: 'Calibrating — stay quiet', calibration_needed: 'Calibration failed — restart in a quiet room',
  candidate: 'Listening to onset…', voiced_speech: 'Voiced speech', whisper_like: 'Whisper-like (tentative)',
  uncertain_audio: 'Uncertain audio', transient: 'Brief transient', pause: 'Pause — holding turn', silence: 'Listening',
};
let context, stream, source, capture, engine;
let running = false, starting = false, stopping = false, lastPayload = null;
let flushResolve = null;
let lastFrameState = null;
let queuedTurns = 0;
let transportState = 'not_connected';
let agentReady = false;
let connectionPending = false;
let spokenReply = '';

const dispatcher = new TurnDispatcher(status => {
  transportState = status.state;
  queuedTurns = status.pending;
  const messages = {
    not_connected: `JSON ready locally; no LLM connected (${status.pending} queued).`,
    queued: `Queued for the LLM (${status.pending}).`, sending: `Sending ${status.turn_id}…`,
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
  if (lastFrameState !== frame.state) {
    $('turnStateVal').textContent = labels[frame.state];
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

async function start() {
  if (running || starting || stopping) return;
  if (queuedTurns >= 100) {
    $('notice').textContent = 'Deliver the queued turns or reload before starting another capture.';
    return;
  }
  starting = true;
  $('startBtn').disabled = true;
  $('notice').textContent = 'Allow microphone access, then remain quiet for 1.2 seconds.';
  $('micStatus').textContent = 'Waiting for microphone permission…';
  let permissionTimer;
  try {
    window.speechSynthesis?.cancel();
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone capture requires localhost or HTTPS. Run npm start and open the local page.');
    }
    if (!window.AudioContext) throw new Error('This browser does not support audio capture. Use a current Chrome, Edge, Firefox, or Safari.');
    context = new AudioContext();
    if (!context.audioWorklet) throw new Error('This browser does not support AudioWorklet. Use a current browser.');
    // Request both during the click. A suspended audio context must not prevent
    // getUserMedia from displaying its permission prompt.
    const resumed = context.resume().then(() => null, error => error);
    permissionTimer = setTimeout(() => {
      $('notice').textContent = 'Still waiting for microphone access. Check the browser permission prompt or the microphone icon in its address bar.';
    }, 10000);
    stream = await navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: { ideal: 1 }, autoGainControl: false, noiseSuppression: false,
      echoCancellation: true,
    } });
    clearTimeout(permissionTimer);
    $('micStatus').textContent = 'Starting audio capture…';
    const resumeError = await resumed;
    if (resumeError) throw resumeError;
    engine = new AudioEngine({ onFrame, onTurn, onEvent(payload) {
      logPayload(payload);
      window.dispatchEvent(new CustomEvent('echosphere:audio-event', { detail: structuredClone(payload) }));
    } });
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
    try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    source = context.createMediaStreamSource(stream);
    capture = new AudioWorkletNode(context, 'echosphere-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    capture.onprocessorerror = () => {
      $('notice').textContent = 'Audio processing stopped unexpectedly. Restart the microphone before continuing.';
      void stop();
    };
    capture.port.onmessage = ({data}) => {
      if (data.flushed) { flushResolve?.(); return; }
      if (running) engine.process(data, context.sampleRate);
    };
    running = true;
    source.connect(capture);
    capture.connect(context.destination);
    context.onstatechange = () => {
      if (running && !stopping && context.state !== 'running') {
        $('notice').textContent = 'Audio capture was suspended. Stop and restart before continuing; real-time audio timing is no longer guaranteed.';
      }
    };
    for (const track of stream.getAudioTracks()) track.onended = () => {
      $('notice').textContent = 'The microphone disconnected. Reconnect it, then start again.';
      void stop();
    };
    $('startBtn').textContent = 'Stop microphone';
    $('notice').textContent = 'Stay quiet for calibration. Then speak or whisper naturally. Use headphones when your narrative engine plays audio.';
    $('micStatus').textContent = 'Microphone active · all analysis on this device';
  } catch (error) {
    const hints = {
      NotAllowedError: 'Microphone access was blocked. Allow Microphone in the browser’s site controls and your operating system’s privacy settings, then try again.',
      SecurityError: 'Microphone access is disabled in this browser or page. Check its permission settings, or open the app through the local server.',
      NotFoundError: 'No microphone was found. Connect a microphone and check your system’s selected audio input, then try again.',
      NotReadableError: 'The microphone could not be opened. Close other apps using it and check your system’s audio input, then try again.',
      AbortError: 'Microphone startup was interrupted. Check your audio input and try again.',
    };
    $('notice').textContent = `Could not start: ${hints[error.name] || error.message}`;
    await releaseAudio();
    running = false;
    $('micStatus').textContent = 'Microphone off';
  } finally {
    clearTimeout(permissionTimer);
    starting = false;
    $('startBtn').disabled = false;
  }
}

async function releaseAudio() {
  source?.disconnect();
  capture?.disconnect();
  stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
  if (context && context.state !== 'closed') { context.onstatechange = null; await context.close(); }
  source = null; capture = null; stream = null; context = null;
}

async function stop() {
  if (stopping || !running) return;
  stopping = true;
  $('startBtn').disabled = true;
  source?.disconnect();
  // Finish PCM already captured before closing the context.
  if (capture && context?.state === 'running') {
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
  $('startBtn').disabled = false;
  $('turnStateVal').textContent = 'Stopped';
  $('moodVal').textContent = '—';
  $('micStatus').textContent = 'Microphone off';
  if ($('notice').textContent.startsWith('Stay quiet for calibration.')) {
    $('notice').textContent = 'Microphone stopped. Start again to recalibrate for a new session.';
  }
  stopping = false;
}

$('startBtn').addEventListener('click', () => running ? void stop() : void start());
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
window.addEventListener('pagehide', () => { stream?.getTracks().forEach(track => track.stop()); });

async function connectEvolus() {
  if (connectionPending) return;
  if (!['http:', 'https:'].includes(location.protocol)) {
    $('agentStatus').textContent = 'Open this project with npm start to connect the agent.';
    return;
  }
  connectionPending = true;
  $('connectBtn').disabled = true;
  $('agentStatus').textContent = 'Checking access to your EchoSphere agent…';
  try {
    const response = await fetch('/api/status', { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Start the full project with npm start to connect Evolus.');
    const status = await response.json();
    if (!status.configured) throw new Error(status.error || 'The agent is not configured on the server.');
    agentReady = true;
    $('agentStatus').textContent = status.live_connection_verified
      ? 'EchoSphere agent connected — a response has been received.'
      : 'EchoSphere agent found. Ready for your next turn.';
    $('deliveryStatus').textContent = 'Completed turns will be sent to your EchoSphere agent.';
    await dispatcher.setHandler(async payload => {
      const resultResponse = await fetch('/api/turn', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(75000),
      });
      const result = await resultResponse.json();
      if (!resultResponse.ok) throw new Error(result.error || `Backend returned HTTP ${resultResponse.status}`);
      if (result.turn_id !== payload.turn_id || typeof result.reply !== 'string') throw new Error('Unexpected agent response.');
      $('agentReply').textContent = result.reply;
      spokenReply = result.reply;
      $('speakBtn').disabled = false;
      $('agentStatus').textContent = 'EchoSphere agent connected — response received.';
      window.dispatchEvent(new CustomEvent('echosphere:response', { detail: result }));
    });
  } catch (error) {
    agentReady = false;
    $('agentStatus').textContent = `Agent unavailable: ${error.message}`;
  } finally {
    connectionPending = false;
    $('connectBtn').disabled = false;
  }
}

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
  getStatus: () => ({ running, agentReady, turnId: engine?.turn?.id || null, queuedTurns, transportState }),
});
$('startBtn').disabled = false;
$('micStatus').textContent = 'Microphone off';
$('notice').textContent = 'Start in a quiet room and remain silent for 1.2 seconds to calibrate the noise floor.';
void connectEvolus();
