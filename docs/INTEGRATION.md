# Audio pipeline and agent integration

Technical reference for extending EchoSphere. Start with the [project README](../README.md) for running it and [VOICES.md](VOICES.md) for browser speech-model requirements.

## Revised behavior

The AudioWorklet, or its compatibility fallback, captures **contiguous 50 ms PCM frames**. RMS, peak, crest factor, normalized periodicity, estimated pitch, and spectral bands feed a temporal state machine. Main-thread analysis and UI delivery can still be delayed under browser load; 50 ms framing is not a hard real-time guarantee.

| Output | Meaning |
| --- | --- |
| `voiced_speech` | Sustained periodic signal consistent with voiced speech; quiet speech stays voiced. Music and machinery can also be periodic. |
| `whisper_like` | Sustained unvoiced, speech-band energy with temporal modulation. Tentative: a breath or changing background noise can resemble it. |
| `transient` | Short isolated unvoiced burst, with sharp attack/crest and observed rapid decay. A high RMS or high zero-crossing count alone cannot trigger it. |
| `uncertain_audio` | Insufficient speech/whisper evidence. Report separately instead of assigning an emotion. |

An onset is buffered for 200 ms. An isolated burst needs 150 ms of following quiet before it is reported. Whisper-like evidence requires at least 350 ms and stabilization. Established voiced speech holds through unvoiced consonants for up to 700 ms; a sustained switch to whisper can therefore take about one second. This trades instant labels for fewer false changes. Short voiced utterances below 200 ms are conservatively reported as uncertain short audio.

Conversation starts speculative recognition at a 250 ms pause and submits after 650–850 ms below the calibrated gate. Only final recognized text is sent; a resumed utterance invalidates its speculative result. Microphone-only mode uses an 800 ms endpoint. Long turns split at 30 seconds (`continues: true`), so frame storage stays bounded. Manual stop flushes an active turn. Silence does not dilute active-audio energy. Style duration, RMS energy, pitch evidence, clipping, uncertainty, and transcripts are summarized independently; loudness does not imply anger, urgency, or mood.

Brief impulses inside an established utterance are absorbed by the turn's continuity rather than switching the whole turn to “transient.” Long coughs or blowing may remain uncertain or resemble speech; this is not a cough recognizer. Continuous noise that rises after calibration may prevent an early endpoint; recalibrate if the environment changes. Noise cancellation/automatic gain control are requested off where supported, but browser/device settings may override those requests.

## JSON and integration

`echosphere:frame` is emitted every analyzed 50 ms frame for ambient sound/haptic control. **Do not invoke an LLM 20 times per second.** `echosphere:audio-event` reports bursts/uncertain audio separately. `echosphere:turn` contains a completed turn, ready for an agent:

```json
{
  "schema_version": "1.0",
  "event": "user_turn_complete",
  "session_id": "session-uuid",
  "turn_id": "session-uuid:1",
  "timing": {
    "start_ms": 1200,
    "end_ms": 3200,
    "duration_ms": 2000,
    "active_audio_ms": 2000,
    "end_reason": "silence",
    "continues": false
  },
  "transcript": null,
  "speech_evidence": {
    "source": "acoustic_heuristics",
    "words_available": false,
    "speech_confirmed_by_asr": false,
    "certainty": "low"
  },
  "prosody_analysis": {
    "dominant_style": "whisper_like",
    "style_duration_ms": { "voiced_speech": 0, "whisper_like": 1600, "uncertain_audio": 400 },
    "average_rms_dbfs": -34.2,
    "peak_dbfs": -20.5,
    "signal_above_noise_db": 25.8,
    "voiced_fraction": 0,
    "median_pitch_hz": null
  },
  "quality": {
    "noise_floor_dbfs": -60,
    "clipped": false,
    "possible_non_speech": true,
    "emotion_inferred": false
  },
  "llm_guidance": "Use prosody as tentative delivery context; do not invent words or infer emotion."
}
```

Values above are illustrative. Scores/labels are not calibrated confidence probabilities. dBFS is digital amplitude relative to full scale, **not calibrated sound pressure** and not a device-independent “intensity percent.” There is intentionally no `dominant_mood` field. Typed actions use `event: "user_text"`, a `transcript` marked `source: "typed"`, and `prosody_analysis: null`; they never fabricate acoustic measurements.

### Live Evolus agent integration

The confirmed route is:

```text
GET  https://api.evolus.ai/v1/models
POST https://api.evolus.ai/v1/chat/completions
Authorization: Bearer <server-side key>
```

Evolus uses `applicationId:agentId` in the chat API’s `model` field. The authenticated model list returned:

```text
8f6b7471-0aaf-43f0-ad70-474e17559724:405d18ba-6acf-43cd-9d76-7eddb9710603
```

The agent is `405d18ba-6acf-43cd-9d76-7eddb9710603`. Its underlying model is configured in Evolus as `own/gemma-4-31b-it`, but using that model name directly in this API returned HTTP 400 with “Expected: {applicationId}:{agentId}.” The full route returned a real narrative response. No extra undocumented agent endpoint is needed.

The backend lists the key’s accessible routes and selects the one matching `EVOLUS_AGENT_ID` (which defaults to this project’s agent). An old `EVOLUS_MODEL=own/gemma-4-31b-it` value is harmless: it is ignored as a routing preference when the accessible agent has a unique match. If several applications expose the same agent, a complete returned `applicationId:agentId` in `EVOLUS_MODEL` resolves the ambiguity. An unrelated agent is never selected just because it is first in the list.

The browser automatically connects after the backend confirms the agent route. The backend sends the complete turn JSON as a user message, with separate guidance about uncertain acoustic cues, and returns the actual agent reply. Recent successful turns are included as context: up to six exchanges per session, across at most 32 sessions. Microphone restarts preserve the story in the same browser tab; reloading starts a fresh session. Conversation history and delivery caches are in memory and disappear when the server restarts.

The saved Evolus agent’s behavior still applies. During live checks it returned Italian narration, including when the adapter requested English. Set the desired language in the agent’s own instructions if needed; the adapter cannot guarantee that its extra system message overrides the agent configuration. It also cannot independently audit the AMD deployment behind Evolus.

The server exposes browser assets plus `/api/health`, `/api/status`, `/api/config`, `/api/check`, and `/api/turn`. The local setup and connection-test routes require a per-process setup token and same-origin requests. Hosted mode disables credential changes, isolates visitor sessions using secure cookies, and caps real API calls. The browser uses the same origin for assets and API requests. Status distinguishes a verified agent route from an actual successful completion in the current process. Requests are same-origin, size-limited, validated, and timed out. The backend never returns credentials. Keys entered into the setup form are sent to the local backend, cleared from the input, and never saved in browser storage. Completed and concurrent retries of a turn ID reuse a cached response; a reused ID with different content is rejected. Failed calls remain retryable, and turns in one session are ordered. The cache retains 256 successful turns; production use needs durable idempotency and persistence.

Browser delivery retains failures for the Retry button. Queues disappear on reload, and capture stops at 100 undelivered turns. `Download latest JSON` saves only the currently displayed event. No hardcoded mock reply is shown in normal operation.

### Custom integration

`echosphere:frame` supplies continuous telemetry, `echosphere:audio-event` carries uncertain/transient events, `echosphere:turn` supplies completed turns, and `echosphere:response` carries the real agent reply. A different backend can register `window.echoSphere.setTurnHandler(async payload => { ... })`. Resolve only after acceptance and throw on failure. This replaces the built-in delivery handler.

A separate local JSON receiver can use `window.echoSphere.connectLocalEndpoint({url: YOUR_LOCAL_ENDPOINT})`. The helper permits only loopback HTTP(S), refuses redirects, and expects a successful HTTP status. The included server accepts same-origin requests; a separate receiver must configure its own CORS policy.

### Local ASR and custom recognizers

Conversation mode includes a browser worker that loads Whisper base.en by default (tiny.en optional), resamples captured PCM to 16 kHz, removes low-frequency/DC rumble, applies bounded gain to quiet audio, and joins the final transcript to the correct completed acoustic segment before dispatch. PCM stays in a bounded 35-second local buffer. At most four completed recognition jobs queue; the UI asks for a pause if recognition falls behind. Model assets download on request and are not committed to Git. No transcript is fabricated when recognition fails.

A custom recognizer can still feed cumulative recognition results while a detector turn is active:

```js
const { turnId } = window.echoSphere.getStatus();
window.echoSphere.addTranscript({
  turnId,
  text: 'Stay quiet, someone is outside.',
  isFinal: true,
  source: 'your_local_asr',
});
```

Store the turn ID when submitting audio to ASR and return **that same ID**, not whichever ID is current when the result arrives. Interim results replace earlier text rather than being concatenated repeatedly. Late results after the turn has closed return `false`; your backend must buffer/join them by ID if ASR runs slower than the 800 ms endpoint. No words means `transcript: null`, and the agent should only use tentative delivery context. For stronger real-world separation, use a speech VAD/model validated on whispers plus representative recordings from the actual microphone. A general VAD is not automatically good at whispering.
