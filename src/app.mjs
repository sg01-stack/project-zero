import { AudioEngine } from './audio-engine.mjs';
import { WORKLET_SOURCE, TurnDispatcher, createLocalJsonHandler, createCompatibilityCapture } from './capture.mjs';

const $ = id => document.getElementById(id);
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
  $('inputMeter').value = Math.max(-100, frame.level_dbfs);
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
  if (running || starting || stopping) return;
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
window.addEventListener('pagehide', () => { stream?.getTracks().forEach(track => track.stop()); });

async function connectEvolus() {
  if (connectionPending) return false;
  if (!['http:', 'https:'].includes(location.protocol)) {
    $('launchHelp').hidden = false;
    $('agentStatus').textContent = 'The agent needs the local app. Double-click Start EchoSphere.cmd in the extracted folder.';
    $('connectBtn').disabled = true;
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
    $('agentSetup').hidden = false;
    $('agentIdInput').value = status.agent_id;
    if (!status.configured) {
      $('agentSetup').open = true;
      throw new Error(status.error || 'Enter your Evolus key below to connect this computer.');
    }
    agentReady = true;
    $('testAgentBtn').disabled = false;
    $('agentStatus').textContent = status.live_connection_verified
      ? 'EchoSphere agent connected — a real response has been received.'
      : 'EchoSphere agent found. Test the connection or start speaking.';
    $('deliveryStatus').textContent = 'Completed turns will be sent to your EchoSphere agent.';
    // Attach the handler without blocking setup on previously queued turns.
    void dispatcher.setHandler(async payload => {
      const resultResponse = await fetch('/api/turn', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(75000),
      });
      const result = await resultResponse.json();
      if (!resultResponse.ok) throw new Error(result.error || `Backend returned HTTP ${resultResponse.status}`);
      if (result.turn_id !== payload.turn_id || typeof result.reply !== 'string') throw new Error('Unexpected agent response.');
      showReply(result.reply);
      $('agentStatus').textContent = 'EchoSphere agent connected — response received.';
      window.dispatchEvent(new CustomEvent('echosphere:response', { detail: result }));
    });
    return true;
  } catch (error) {
    agentReady = false;
    $('testAgentBtn').disabled = true;
    void dispatcher.setHandler(null);
    $('agentStatus').textContent = `Agent unavailable: ${error.message}`;
    if (!setupToken) $('launchHelp').hidden = false;
    return false;
  } finally {
    connectionPending = false;
    $('connectBtn').disabled = false;
  }
}

function showReply(reply) {
  $('agentReply').textContent = reply;
  spokenReply = reply;
  $('speakBtn').disabled = false;
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
  getStatus: () => ({ running, starting, captureMode, frameCount, diagnostic: structuredClone(diagnostic), agentReady, turnId: engine?.turn?.id || null, queuedTurns, transportState }),
});
$('startBtn').disabled = false;
$('micStatus').textContent = 'Microphone off';
$('notice').textContent = 'Start in a quiet room and remain silent for 1.2 seconds to calibrate the noise floor.';
void connectEvolus();
void refreshMicrophones();
