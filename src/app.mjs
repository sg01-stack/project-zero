import { OfflineStory, SceneAudio, sceneControls, tourFrame } from './experience.mjs';
import { AtomExperience } from './visuals.mjs';
import { VOICE_PRESETS, voicePosition, speechSegments, SpatialVoice, NeuralVoice } from './voice.mjs';
import { SpeechRecognizer, SpeechBuffer, vocalDelivery } from './conversation.mjs';
import { storyPlacement, NarrationBuffer, readNarrationResponse } from './narrative.mjs';
import { AudioEngine } from './audio-engine.mjs';
import { WORKLET_SOURCE, TurnDispatcher, createLocalJsonHandler, createCompatibilityCapture } from './capture.mjs';

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
let voiceBusy = false, speechRun = 0, voiceMotion = 'still', recordingFile = null;
const spatialVoice = new SpatialVoice(position => {
  const radius = Math.min(42, 18 + position.distance * 2);
  const angle = position.angle * Math.PI / 180;
  $('voiceDot').style.left = `${50 + Math.sin(angle) * radius}%`;
  $('voiceDot').style.top = `${50 - Math.cos(angle) * radius}%`;
});
const neuralVoice = new NeuralVoice(message => { $('voiceStatus').textContent = message; if (preparingConversation) $('heroStatus').textContent = message; });
const recognizer = new SpeechRecognizer(message => { $('conversationStatus').textContent = message; if (preparingConversation) $('heroStatus').textContent = message; });
const speechBuffer = new SpeechBuffer();
let conversationRequested = false, conversationActive = false, preparingConversation = false, conversationEpoch = 0;
let recognitionChain = Promise.resolve(), recognitionPending = 0, interactionVersion = 0, pendingVoice = null, bargeMs = 0, barged = false, interruptions = 0;
let deliveryProfile = { intensity: 0.3, soft: false };
let activeRequest = null, speculativeRecognition = null, storyStarted = false;
let lastStoryActivity = performance.now(), idleNudgeUsed = false, scenePreset = 'guide';
const turnVersions = new Map();
const comparisonTurns = new Map();
const neuralChoices = [['af_heart', 'Heart · American'], ['af_bella', 'Bella · American'], ['af_nicole', 'Nicole · American'],
  ['af_sarah', 'Sarah · American'], ['am_michael', 'Michael · American'], ['am_fenrir', 'Fenrir · American'],
  ['bf_emma', 'Emma · British'], ['bf_isabella', 'Isabella · British'], ['bm_george', 'George · British'], ['bm_fable', 'Fable · British']];

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
    recordComparison(payload.turn_id, reply, 'Offline script');
    offerAutomaticReply(reply, payload.turn_id);
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
  idleNudgeUsed = false; lastStoryActivity = performance.now();
  pendingVoice = null;
  if (voiceBusy && conversationActive) void stopNarration(true);
  if (conversationRequested && payload.event === 'user_turn_complete') {
    if (!recognizer.ready || !conversationActive) { $('conversationStatus').textContent = 'Conversation is preparing or paused. Wait for Ready before speaking.'; return; }
    const pcm = speechBuffer.between(payload.timing.start_ms, payload.timing.end_ms);
    const epoch = conversationEpoch, version = ++interactionVersion;
    const speculative = speculativeRecognition?.turnId === payload.turn_id && speculativeRecognition.endMs === payload.timing.end_ms ? speculativeRecognition : null;
    speculativeRecognition = null;
    if (recognitionPending >= 4) { $('conversationStatus').textContent = 'Speech recognition is catching up. Pause briefly, or type your action below.'; return; }
    recognitionPending++;
    recognitionChain = recognitionChain.then(async () => {
      if (epoch !== conversationEpoch) return;
      $('conversationStatus').textContent = 'Understanding your words locally…';
      // Recognition can start at the first short pause. Reuse it only if the
      // utterance did not resume; speculative text is never sent to the LLM.
      let result = speculative ? await speculative.promise : null;
      if (!result || result.error) {
        await recognizer.idle;
        if (epoch !== conversationEpoch) return;
        result = await recognizer.transcribe(pcm);
      }
      if (epoch !== conversationEpoch) return;
      if (!result.text.trim()) { $('conversationStatus').textContent = 'No words recognized. Please repeat, or type your action.'; return; }
      payload.transcript = { text: result.text, source: result.source || `local_whisper_${recognizer.model}_en`, is_final: true };
      payload.speech_evidence = { ...payload.speech_evidence, words_available: true, speech_confirmed_by_asr: true, source: 'acoustic_heuristics_and_asr' };
      $('transcriptText').textContent = result.text;
      $('conversationStatus').textContent = conversationActive ? 'Words recognized. The narrator is responding; you can keep speaking.' : 'Words recognized. A text response will arrive; conversation playback is paused.';
      submitTurn(payload, version);
    }).catch(error => { if (epoch === conversationEpoch) $('conversationStatus').textContent = `${error.message} You can still type a story action.`; })
      .finally(() => { recognitionPending--; });
    return;
  }
  submitTurn(payload, ++interactionVersion);
}
function submitTurn(payload, version) {
  payload.session_id = textSession;
  if (payload.transcript?.text) placeNarration(payload.transcript.text);
  turnVersions.set(payload.turn_id, version);
  if (turnVersions.size > 100) turnVersions.delete(turnVersions.keys().next().value);
  logPayload(payload);
  window.dispatchEvent(new CustomEvent('echosphere:turn', { detail: structuredClone(payload) }));
  dispatcher.enqueue(payload);
  if (queuedTurns >= 100) {
    $('notice').textContent = '100 turns are queued without delivery. Capture stopped to avoid an unbounded queue; connect your handler or reload to start a new session.';
    void stop();
  }
}

function offerAutomaticReply(text, turnId) {
  const version = turnVersions.get(turnId);
  if ((conversationActive || conversationRequested) && version === interactionVersion) {
    if (!pendingVoice || pendingVoice.version !== version) pendingVoice = { segments: [], version };
    pendingVoice.segments.push(text);
  }
}

function requestStory(event = 'story_continue') {
  if (!['live', 'offline'].includes(narrativeMode) || queuedTurns || recognitionPending) return;
  storyStarted = true; lastStoryActivity = performance.now();
  submitTurn({ schema_version: '1.0', event, turn_id: `story:${crypto.randomUUID()}`, session_id: textSession,
    transcript: null, prosody_analysis: null,
    llm_guidance: event === 'story_start' ? 'Lead the opening, introduce the guide and invite participation. No user speech has occurred.'
      : 'Offer one gentle story development. The participant has not supplied new words; do not invent their decisions.' }, ++interactionVersion);
}

function placeNarration(text) {
  if (!$('autoPlacement').checked) return;
  const scene = storyPlacement(text, scenePreset);
  if (scene.preset !== scenePreset) spatialVoice.sceneStarted = null;
  scenePreset = scene.preset;
  $('voicePreset').value = scenePreset; voiceMotion = scene.options.motion;
  for (const [id, key] of [['voiceAngle', 'angle'], ['voiceDistance', 'distance'], ['voiceRoom', 'room'], ['voiceSpeed', 'speed']]) $(id).value = scene.options[key];
  configureVoice();
  $('spatialStatus').textContent = `Following the story: ${$('voicePreset').selectedOptions[0].textContent}. Your vocal delivery continues to shape distance and room tone.`;
}

function onFrame(frame) {
  visuals.react(frame);
  const controls = sceneControls(frame);
  sceneAudio.update(controls);
  deliveryProfile = vocalDelivery(frame, deliveryProfile);
  if (conversationActive) {
    spatialVoice.modulate(deliveryProfile);
    const speaking = ['voiced_speech', 'whisper_like', 'uncertain_audio'].includes(frame.state);
    if (speaking) engine.options.endSilenceMs = frame.state === 'whisper_like' ? 850 : 650;
    if (speaking || frame.state === 'candidate' || frame.state === 'pause' || voiceBusy || pendingVoice || queuedTurns || recognitionPending) lastStoryActivity = performance.now();
    if (speaking && (voiceBusy || pendingVoice || transportState === 'sending')) {
      bargeMs += 50;
      if (bargeMs >= 200 && !barged) {
        barged = true; interactionVersion++; interruptions++; pendingVoice = null;
        activeRequest?.abort();
        void stopNarration(true);
        $('conversationStatus').textContent = 'Listening to you. Narration interrupted; the microphone stays active.';
      }
    } else if (!speaking) { bargeMs = 0; barged = false; }
    if (frame.state === 'pause' && engine.silenceMs >= 250 && engine.turn && recognizer.ready && !recognizer.pending && !recognitionPending &&
        (speculativeRecognition?.turnId !== engine.turn.id || speculativeRecognition.endMs !== engine.turn.lastActiveMs)) {
      const { id: turnId, startMs, lastActiveMs: endMs } = engine.turn;
      speculativeRecognition = { turnId, endMs, promise: recognizer.transcribe(speechBuffer.between(startMs, endMs)).catch(error => ({ error })) };
    }
    if (pendingVoice && pendingVoice.version === interactionVersion && frame.state === 'silence' && !voiceBusy) {
      const reply = pendingVoice.segments.shift(); if (!pendingVoice.segments.length) pendingVoice = null;
      void playNarration(reply, null, true);
    }
    if (frame.state === 'silence' && !voiceBusy && !pendingVoice && !queuedTurns && !recognitionPending &&
        $('storyLead').checked && !idleNudgeUsed && performance.now() - lastStoryActivity > 20000) {
      idleNudgeUsed = true; requestStory();
    }
  }
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
  return new AudioEngine({ endSilenceMs: conversationRequested ? 650 : 800, onFrame, onTurn, onEvent(payload) {
    logPayload(payload);
    window.dispatchEvent(new CustomEvent('echosphere:audio-event', { detail: structuredClone(payload) }));
    if (conversationActive && ['uncertain_short_audio', 'uncertain_audio'].includes(payload.audio_type)) {
      const pcm = speechBuffer.between(payload.start_ms, payload.end_ms);
      if (pcm.length >= 1600) {
        const rms = Math.sqrt(pcm.reduce((sum, value) => sum + value * value, 0) / pcm.length);
        onTurn({ schema_version: '1.0', event: 'user_turn_complete', session_id: payload.session_id, turn_id: `asr:${payload.event_id}`,
          timing: { start_ms: payload.start_ms, end_ms: payload.end_ms, end_reason: 'uncertain_audio_check' }, transcript: null,
          prosody_analysis: { dominant_style: 'uncertain_audio', average_rms_dbfs: 20 * Math.log10(Math.max(1e-10, rms)), peak_dbfs: payload.peak_dbfs },
          quality: { emotion_inferred: false, possible_non_speech: true },
          llm_guidance: 'The acoustic detector was uncertain. Speech recognition can be mistaken; do not infer emotion from this sound.' });
      }
    }
  } });
}

async function initializeExperience() {
  if (!$('conversationToggle').checked) return start();
  if (preparingConversation) return;
  if (!['http:', 'https:'].includes(location.protocol)) {
    $('heroStatus').textContent = 'This standalone file is a visual preview. Conversation needs the hosted app or Start EchoSphere.cmd.';
    $('launchHelp').hidden = false; $('workspace').scrollIntoView({ behavior: 'smooth' }); return;
  }
  preparingConversation = true; conversationRequested = true; conversationActive = false;
  const epoch = ++conversationEpoch; interactionVersion++; pendingVoice = null;
  if (recognizer.pending) recognizer.cancel();
  $('conversationStatus').textContent = 'Starting microphone and checking narration…';
  const microphone = start();
  // Audio activation belongs to this user gesture, before any model downloads.
  const output = spatialVoice.unlock().then(() => null, error => error);
  if (!$('ambienceToggle').dataset.userChoice) {
    $('ambienceToggle').checked = true;
    void sceneAudio.enable().catch(() => { $('ambienceToggle').checked = false; });
  }
  try {
    await microphone; const audioError = await output; if (audioError) throw audioError;
    if (!running || epoch !== conversationEpoch) return;
    while (connectionPending) await new Promise(resolve => setTimeout(resolve, 100));
    if (narrativeMode === 'waiting') throw new Error('The narrator is not connected. Configure Evolus in Your narrative agent, or explicitly choose the offline scripted scene. Evolus Studio is not required.');
    $('voiceEngine').value = 'neural'; refreshVoices();
    $('initializeLabel').textContent = 'Preparing conversation. Click to Stop.';
    $('heroStatus').textContent = 'Downloading speech models into this browser. Progress is in Story & controls.';
    $('conversationStatus').textContent = 'Loading speech recognition and neural voices. The first download can be several hundred MB; wait for Ready.';
    // Fetch the opening while local models load, instead of waiting for the
    // participant to manufacture the first line of the story.
    if ($('storyLead').checked) requestStory(storyStarted ? 'story_continue' : 'story_start');
    await Promise.all([recognizer.load($('recognitionModel').value), neuralVoice.load()]);
    if (!running || epoch !== conversationEpoch) return;
    conversationActive = true; engine = newEngine(); speechBuffer.clear(); speculativeRecognition = null; lastFrameState = null; lastStoryActivity = performance.now();
    $('initializeLabel').textContent = 'Listening. Click to Pause.';
    $('conversationStatus').textContent = `Ready · ${narrativeMode === 'live' ? 'live Evolus narration' : 'offline scripted scene'}. Stay quiet for 1.2 seconds. The guide will begin; speak any time to interrupt.`;
  } catch (error) {
    if (epoch === conversationEpoch) {
      const message = `Conversation could not start: ${error.message}`;
      await stop();
      if (recognizer.pending) recognizer.cancel();
      if (neuralVoice.pending) neuralVoice.cancel();
      $('conversationStatus').textContent = message; $('heroStatus').textContent = message;
    }
  } finally {
    preparingConversation = false;
    if (!running) {
      conversationRequested = false;
      await spatialVoice.close();
      if (!$('ambienceToggle').dataset.userChoice) { await sceneAudio.disable(); $('ambienceToggle').checked = false; }
    }
  }
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
  void stopNarration();
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
    speechBuffer.clear();
    const receive = data => {
      if (!running) return;
      frameCount++; lastAudioAt = performance.now();
      try { if (conversationRequested) speechBuffer.push(data, context.sampleRate, engine.timeMs + 50); engine.process(data, context.sampleRate); }
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

async function stop({ preservePlayback = false } = {}) {
  if (stopping || !running) return;
  const wasConversation = conversationRequested;
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
  if (conversationRequested) { void sceneAudio.disable(); $('ambienceToggle').checked = false; }
  conversationActive = false; conversationRequested = false; pendingVoice = null;
  if (wasConversation || preparingConversation) activeRequest?.abort();
  speculativeRecognition = null; idleNudgeUsed = true;
  $('conversationStatus').textContent = 'Conversation paused. Initialize to resume.';
  if (!preservePlayback) void stopNarration();
  if (wasConversation || preparingConversation) { conversationEpoch++; if (recognizer.pending) recognizer.cancel(); }
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
$('initializeBtn').addEventListener('click', () => starting ? startupController?.abort() : running ? void stop() : void initializeExperience());
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
window.addEventListener('pagehide', () => { stream?.getTracks().forEach(track => track.stop()); void stopNarration(); neuralVoice.cancel(); recognizer.cancel(); void sceneAudio.disable(); navigator.vibrate?.(0); });

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
      const controller = new AbortController(); activeRequest = controller;
      const sentences = new NarrationBuffer(); let streamed = false, partial = '';
      const version = turnVersions.get(payload.turn_id);
      try {
        const resultResponse = await fetch('/api/turn', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
          body: JSON.stringify(payload), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(75000)]),
        });
        const result = await readNarrationResponse(resultResponse, delta => {
          if (version !== interactionVersion || controller.signal.aborted) return;
          streamed = true; partial += delta;
          $('replySource').textContent = 'Live Evolus agent · arriving'; $('agentReply').textContent = partial;
          for (const sentence of sentences.push(delta)) offerAutomaticReply(sentence, payload.turn_id);
        });
        if (result.turn_id !== payload.turn_id || typeof result.reply !== 'string') throw new Error('Unexpected agent response.');
        recordComparison(payload.turn_id, result.reply, 'Live Evolus agent');
        if (version === interactionVersion && !controller.signal.aborted) {
          showReply(result.reply, 'Live Evolus agent');
          if (streamed) { for (const sentence of sentences.push('', true)) offerAutomaticReply(sentence, payload.turn_id); }
          else offerAutomaticReply(result.reply, payload.turn_id);
        }
        $('agentStatus').textContent = 'EchoSphere agent connected — response received.';
        window.dispatchEvent(new CustomEvent('echosphere:response', { detail: result }));
      } catch (error) {
        recordComparison(payload.turn_id, controller.signal.aborted ? 'Interrupted. Try this input again when ready.' : error.message, 'Request incomplete');
        if (!controller.signal.aborted) {
          if (version === interactionVersion) { pendingVoice = null; void stopNarration(conversationActive); }
          throw error;
        }
      } finally { if (activeRequest === controller) activeRequest = null; }
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
  $('speakBtn').disabled = voiceBusy;
  $('heroStory').textContent = 'Your story has a new response. Read it below ↓';
}

function recordComparison(turnId, reply, source) {
  const output = comparisonTurns.get(turnId);
  if (output) { $(output).textContent = `${source}: ${reply}`; comparisonTurns.delete(turnId); }
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

function systemVoices() { return window.speechSynthesis?.getVoices().filter(voice => voice.localService) || []; }
function voiceKey(voice) { return voice.voiceURI || `${voice.name}:${voice.lang}`; }
function refreshVoices() {
  const previous = $('voiceSelect').value, neural = $('voiceEngine').value === 'neural';
  const choices = neural ? neuralChoices : systemVoices().map(voice => [voiceKey(voice), `${voice.name} · ${voice.lang}`]);
  $('voiceSelect').replaceChildren(...choices.map(([value, label]) => new Option(label, value)));
  if (choices.some(([key]) => key === previous)) $('voiceSelect').value = previous;
  if (!choices.length) $('voiceSelect').add(new Option('No installed voices exposed by this browser', ''));
  $('loadVoiceBtn').hidden = !neural; $('refreshVoicesBtn').hidden = neural;
  $('spatialControls').disabled = !neural;
  $('voiceHelp').textContent = neural
    ? 'Kokoro generates English speech on your device. First use downloads the model and runtime (roughly 100 MB or more) from Hugging Face and jsDelivr. Text stays local. Browser caching may avoid repeat downloads.'
    : 'Only installed local voices are listed. On Windows, add speech voices in Settings → Time & language → Speech, then restart Edge. Some Narrator voices are not exposed to websites.';
  $('spatialStatus').textContent = neural
    ? 'Neural speech uses binaural HRTF positioning, distance filtering, and room reflections. Use headphones; front/back perception varies by listener.'
    : 'System speech plays flat: browsers do not expose its audio to 3D processing. Choose Kokoro or play a recording for spatial audio.';
}
function setVoiceBusy(value) {
  voiceBusy = value;
  $('previewVoiceBtn').disabled = value; $('loadVoiceBtn').disabled = value;
  $('speakBtn').disabled = value || !spokenReply; $('playFileBtn').disabled = value || !recordingFile;
}
function configureVoice() {
  const options = { angle: Number($('voiceAngle').value), distance: Number($('voiceDistance').value), room: Number($('voiceRoom').value), motion: voiceMotion };
  $('voiceAngleVal').textContent = `${Math.abs(options.angle)}° ${options.angle < 0 ? 'left' : options.angle > 0 ? 'right' : 'ahead'}`;
  $('voiceDistanceVal').textContent = `${options.distance.toFixed(1)} m`;
  $('voiceRoomVal').textContent = `${Math.round(options.room * 100)}%`;
  $('voiceSpeedVal').textContent = `${Number($('voiceSpeed').value).toFixed(2)}×`;
  spatialVoice.configure(options); spatialVoice.onPosition(voicePosition(options));
}
async function stopNarration(keepConversationAudio = false) {
  speechRun++; window.speechSynthesis?.cancel();
  if (neuralVoice.pending && !(keepConversationAudio && neuralVoice.pending.type === 'generate')) neuralVoice.cancel();
  setVoiceBusy(false);
  if (keepConversationAudio) spatialVoice.interrupt(); else await spatialVoice.close();
}
async function playNarration(text, file = null, automatic = false) {
  if (voiceBusy || (!text && !file)) return;
  if (starting) { startupController?.abort(); $('playbackStatus').textContent = 'Microphone request cancelled. Press Play again when it has stopped.'; return; }
  const run = ++speechRun, neural = $('voiceEngine').value === 'neural';
  let systemQueued = false;
  setVoiceBusy(true);
  try {
    // Resume from this click gesture, before model download or microphone cleanup.
    const unlock = (neural || file) ? spatialVoice.unlock() : Promise.resolve();
    // Observe rejection immediately while capture cleanup is in progress.
    const unlocked = unlock.then(() => null, error => error);
    if (running && !automatic) await stop({ preservePlayback: true });
    const error = await unlocked; if (error) throw error;
    if (run !== speechRun) return;
    window.speechSynthesis?.cancel();
    if (!automatic) spatialVoice.sceneStarted = null;
    if (file) {
      const decoded = await spatialVoice.context.decodeAudioData(await file.arrayBuffer());
      if (run !== speechRun) return;
      if (decoded.duration > 180) throw new Error('Choose a recording shorter than three minutes.');
      const mono = new Float32Array(decoded.length);
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const values = decoded.getChannelData(channel);
        for (let i = 0; i < mono.length; i++) mono[i] += values[i] / decoded.numberOfChannels;
      }
      $('spatialControls').disabled = false;
      $('spatialStatus').textContent = 'Your recording is playing through HRTF positioning and room effects. Adjust direction or distance while it plays.';
      $('playbackStatus').textContent = 'Playing your recording in 3D. Microphone paused.';
      await spatialVoice.play(mono, decoded.sampleRate);
    } else if (neural) {
      $('playbackStatus').textContent = automatic ? 'Preparing the next spoken line. Still listening to you.' : 'Preparing local neural narration. Microphone paused.';
      await neuralVoice.load();
      const segments = speechSegments(text), voice = $('voiceSelect').value;
      await neuralVoice.idle;
      const generate = segment => neuralVoice.generate(segment, voice, Number($('voiceSpeed').value) * (automatic ? deliveryProfile.soft ? 0.9 : 0.95 + deliveryProfile.intensity * 0.1 : 1))
        .then(audio => ({ audio }), error => ({ error }));
      let pending = segments.length ? generate(segments[0]) : null;
      for (let i = 0; i < segments.length; i++) {
        if (run !== speechRun) return;
        $('voiceStatus').textContent = `Generating locally: passage ${i + 1} of ${segments.length}…`;
        const result = await pending; if (result.error) throw result.error;
        const { audio } = result;
        if (run !== speechRun) return;
        placeNarration(segments[i]);
        if (i + 1 < segments.length) pending = generate(segments[i + 1]);
        $('playbackStatus').textContent = `Playing neural narration in 3D · passage ${i + 1}/${segments.length}.${automatic ? ' Speak to interrupt.' : ''}`;
        await spatialVoice.play(audio.pcm, audio.sampleRate, !automatic && i + 1 === segments.length);
      }
      $('voiceStatus').textContent = 'Neural voice ready. Change voices to compare another delivery.';
    } else {
      const voices = systemVoices();
      const voice = voices.find(item => voiceKey(item) === $('voiceSelect').value) || voices.find(item => item.lang.startsWith('en')) || voices[0];
      if (!voice) throw new Error('No installed voice is available. Refresh voices, install a speech voice, or load Kokoro.');
      const utterance = new SpeechSynthesisUtterance(text); utterance.voice = voice; utterance.lang = voice.lang;
      utterance.rate = Number($('voiceSpeed').value);
      utterance.onend = () => { if (run === speechRun) { setVoiceBusy(false); $('playbackStatus').textContent = 'Playback finished. Start the microphone when you are ready.'; } };
      utterance.onerror = () => { if (run === speechRun) { setVoiceBusy(false); $('playbackStatus').textContent = 'System voice playback failed. The response remains available as text.'; } };
      $('playbackStatus').textContent = `Playing ${voice.name} locally · flat system audio. Microphone paused.`;
      window.speechSynthesis.speak(utterance);
      systemQueued = true;
      return;
    }
    if (run === speechRun) $('playbackStatus').textContent = automatic ? 'The guide is listening. Speak whenever you like.' : 'Playback finished. Start the microphone when you are ready.';
  } catch (error) { if (run === speechRun) $('playbackStatus').textContent = error.message; }
  finally {
    if (run === speechRun && !systemQueued) { setVoiceBusy(false); if (!conversationActive) await spatialVoice.close(); }
  }
}
function speakReply() { return playNarration(spokenReply); }
$('voiceEngine').addEventListener('change', () => { void stopNarration(); refreshVoices(); $('voiceStatus').textContent = 'Voice engine changed. Audition a voice before playing the response.'; });
$('refreshVoicesBtn').addEventListener('click', refreshVoices);
window.speechSynthesis?.addEventListener('voiceschanged', () => { if ($('voiceEngine').value === 'system') refreshVoices(); });
$('previewVoiceBtn').addEventListener('click', () => void playNarration('The observatory lights fade. I am beside you. Listen carefully. Someone is moving beyond the door.'));
$('stopVoiceBtn').addEventListener('click', () => { pendingVoice = null; interactionVersion++; activeRequest?.abort(); idleNudgeUsed = true; void stopNarration(conversationActive); $('playbackStatus').textContent = `Voice stopped. ${running ? 'Microphone is still listening.' : 'Microphone remains off.'}`; });
$('loadVoiceBtn').addEventListener('click', async () => {
  if (voiceBusy) return;
  const run = ++speechRun; setVoiceBusy(true);
  $('voiceStatus').textContent = 'Downloading and loading neural voices. Stop voice cancels this operation.';
  try { await neuralVoice.load(); if (run === speechRun) $('voiceStatus').textContent = 'Neural voices loaded. Audition a voice with headphones.'; }
  catch (error) { if (run === speechRun) $('voiceStatus').textContent = error.message; }
  finally { if (run === speechRun) setVoiceBusy(false); }
});
$('voicePreset').addEventListener('change', () => {
  $('autoPlacement').checked = false;
  const preset = VOICE_PRESETS[$('voicePreset').value]; voiceMotion = preset.motion;
  for (const [id, key] of [['voiceAngle', 'angle'], ['voiceDistance', 'distance'], ['voiceRoom', 'room'], ['voiceSpeed', 'speed']]) $(id).value = preset[key];
  configureVoice();
});
for (const id of ['voiceAngle', 'voiceDistance', 'voiceRoom', 'voiceSpeed']) $(id).addEventListener('input', () => {
  $('autoPlacement').checked = false;
  if (id === 'voiceAngle') voiceMotion = 'still'; configureVoice();
});
$('voiceFile').addEventListener('change', event => {
  const file = event.target.files[0]; recordingFile = file && file.size <= 20 * 1024 * 1024 ? file : null;
  $('playFileBtn').disabled = voiceBusy || !recordingFile;
  if (file && !recordingFile) $('playbackStatus').textContent = 'Choose an audio recording no larger than 20 MB.';
});
$('playFileBtn').addEventListener('click', () => void playNarration('', recordingFile));
refreshVoices(); configureVoice();
$('prepareConversationBtn').addEventListener('click', () => { if (running) void stop().then(initializeExperience); else void initializeExperience(); });
$('conversationToggle').addEventListener('change', () => {
  if (!$('conversationToggle').checked) { conversationActive = false; conversationRequested = false; pendingVoice = null; activeRequest?.abort(); void stopNarration(); }
});
$('recognitionModel').addEventListener('change', () => {
  if (running) void stop();
  $('conversationStatus').textContent = 'Recognition model changed. Initialize again to load it.';
});
$('continueStoryBtn').addEventListener('click', () => { idleNudgeUsed = true; requestStory(storyStarted ? 'story_continue' : 'story_start'); });

// Register an async handler that resolves only after your server accepts a turn.
// Keep adapters local. Do not enable browser SpeechRecognition implicitly:
// it can send microphone audio to a remote speech service.
window.echoSphere = Object.freeze({
  start, stop, connectEvolus, initializeExperience,
  setTurnHandler: handler => dispatcher.setHandler(handler),
  connectLocalEndpoint: options => dispatcher.setHandler(createLocalJsonHandler(options)),
  retryDelivery: () => dispatcher.retry(),
  addTranscript: result => engine?.setTranscript(result) || false,
  getStatus: () => ({ visual: visuals.getState(), conversation: { active: conversationActive, preparing: preparingConversation, recognitionReady: recognizer.ready, recognitionModel: recognizer.model, recognitionPending, interactionVersion, interruptions, storyStarted }, voice: { busy: voiceBusy, neuralReady: neuralVoice.ready, engine: $('voiceEngine').value, spatial: spatialVoice.options, delivery: deliveryProfile }, narrativeMode, tourActive, running, starting, captureMode, frameCount, diagnostic: structuredClone(diagnostic), agentReady, turnId: engine?.turn?.id || null, queuedTurns, transportState }),
});
$('startBtn').disabled = false;
$('initializeBtn').disabled = false;
$('heroStatus').textContent = 'Headphones recommended. First conversation downloads speech models in your browser.';
$('micStatus').textContent = 'Microphone off';
$('notice').textContent = 'Start in a quiet room and remain silent for 1.2 seconds to calibrate the noise floor.';
void connectEvolus({ selectLive: false });
void refreshMicrophones();

$('offlineBtn').addEventListener('click', useOfflineScene);
$('textForm').addEventListener('submit', event => {
  event.preventDefault();
  const text = $('storyText').value.trim();
  if (sendStoryText(text)) $('storyText').value = '';
});
function sendStoryText(text, comparisonOutput = null) {
  if (!text) return;
  if (narrativeMode === 'waiting') {
    $('modeHelp').textContent = 'Choose Try offline scene or connect live narration first, then send your text.';
    return;
  }
  if (queuedTurns >= 100) { $('modeHelp').textContent = 'Deliver or clear your queued turns before sending more text.'; return; }
  const turnId = `text:${crypto.randomUUID()}`;
  if (comparisonOutput) {
    for (const [key, value] of comparisonTurns) if (value === comparisonOutput) comparisonTurns.delete(key);
    comparisonTurns.set(turnId, comparisonOutput); $(comparisonOutput).textContent = 'Waiting for this story response…';
  }
  onTurn({ schema_version: '1.0', event: 'user_text', session_id: textSession,
    turn_id: turnId, transcript: { text, source: 'typed', is_final: true },
    prosody_analysis: null, llm_guidance: 'This is typed user input. No acoustic measurements or inferred emotion accompany it.' });
  return true;
}
for (const button of document.querySelectorAll('[data-story-example]')) button.addEventListener('click', () => {
  const quiet = button.dataset.storyExample === 'quiet';
  sendStoryText(quiet ? 'I whisper to the guide: please stay beside me and speak softly while we listen at the door.'
    : 'I call across the great hall: is someone there? Let a distant voice answer from the right.', quiet ? 'quietExampleResult' : 'distantExampleResult');
});
$('ambienceToggle').addEventListener('change', async event => {
  event.target.dataset.userChoice = 'true';
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
