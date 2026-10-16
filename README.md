# EchoSphere audio pipeline

EchoSphere captures continuous audio, classifies vocal delivery, and sends completed-turn JSON to the existing Evolus agent backed by the user’s AMD-hosted model. A live browser-to-agent response has been verified. **It is a heuristic prototype, not a trained whisper/speech/noise classifier.** No detector based only on amplitude, zero crossings, and pitch can perfectly distinguish whispers, breathing, wind, coughing, and speech on arbitrary microphones.

## Run

Use Node.js 24.5 or newer. No npm packages or network downloads are required for the application. On your own computer, copy `.env.example` to `.env` and enter your API key there. Only the server reads this file; never put credentials in the HTML. In the configured cloud environment, the published secret is injected automatically. `npm start` enables Node's environment-proxy support and loads an optional local `.env` without replacing injected variables.

```sh
git clone https://github.com/sg01-stack/project-zero.git
cd project-zero
npm test
npm run build
npm start
```

The complete source page is `index.html`, its stylesheet is `style.css`, and the browser modules are in `src/`. You can also use GitHub's **Code → Download ZIP**, extract it, and run the npm commands from that folder. The committed `dist/app.js` bundles the browser modules so the downloaded page can load without an ES module server; run `npm run build` after editing `src/`.

### Downloaded page and microphone troubleshooting

Extract the **entire ZIP** before opening `index.html`; keep `style.css` and the `dist/` folder next to it. The page loads a classic JavaScript bundle because browsers block external ES module imports when opening an HTML file directly from disk. For a single file, open `dist/echosphere.html`. These options provide the local detector; the Evolus agent still needs `npm start` and a server-side API key.

Click **Start microphone**, allow access if prompted, and remain quiet for 1.2 seconds. Browsers that remember an existing permission may start capture without asking again. If permission was blocked previously, allow Microphone in the browser's site controls and check your operating system's microphone privacy settings. Missing or busy devices now show a specific message, and missing app files show extraction instructions.

Some browsers or device policies restrict microphone access from local files. In that case, use Node.js 24.5 or newer, run `npm start` in the extracted project folder, and open the local address printed by the server on the same computer as your microphone. An ordinary HTTP page on a remote computer is not a secure microphone context; use the local server or HTTPS.

Open the local server on port 8000 in a browser on the **same machine as the microphone**. A remote development container cannot capture your laptop microphone through its own loopback interface. For detector-only local use, download `dist/echosphere.html`, serve its directory with `python3 -m http.server 8000`, and open the served file in your browser. For Evolus integration, use the full project and `npm start`. Microphone capture requires a secure context (localhost or HTTPS) and permission. The standalone file contains all JavaScript and styles; no CDNs or browser speech-recognition services are used.

Wait for “EchoSphere agent found,” then click Start and remain quiet for the first 1.2 seconds. Use headphones if the narrative engine plays audio. Stop/Start recalibrates after changing microphones or environments and begins a new story session. “Play response” uses an installed local voice and stops microphone capture to prevent narration from feeding back into the detector. If no local voice is available, the text remains usable. Loud, variable, or voiced calibration input is rejected instead of quietly learning your speech as noise.

## What was wrong

- The old `volume > 55 || (volume > 25 && zeroCrossings > 75)` condition made loud speech and unvoiced consonants/whispers become transients. Zero crossings indicate frequency/noisiness, not a transient's duration or meaning.
- “Transient” changed immediately; recovering a speech label took several frames. Display flicker was built into that asymmetry.
- A 512-sample analyzer polled every 30 ms observed only roughly 11 ms at 48 kHz, with gaps and timer-dependent timing.
- The baseline learned loud speech, not just background noise. Low-amplitude voiced speech was treated as whispering.
- `dominantMood` was the latest label rather than a duration-based summary; it was not reset with the other turn statistics.
- Recognition results were discarded. Browser `SpeechRecognition` is not reliably local and may miss whispers or return late.
- The JSON was displayed but never submitted. Hardcoded synthesized replies were not LLM responses and could feed back into the microphone.

## Revised behavior

The AudioWorklet captures **contiguous 50 ms PCM frames**. RMS, peak, crest factor, normalized periodicity, estimated pitch, and spectral bands feed a temporal state machine. Main-thread analysis and UI delivery can still be delayed under browser load; 50 ms framing is not a hard real-time guarantee.

| Output | Meaning |
| --- | --- |
| `voiced_speech` | Sustained periodic signal consistent with voiced speech; quiet speech stays voiced. Music and machinery can also be periodic. |
| `whisper_like` | Sustained unvoiced, speech-band energy with temporal modulation. Tentative: a breath or changing background noise can resemble it. |
| `transient` | Short isolated unvoiced burst, with sharp attack/crest and observed rapid decay. A high RMS or high zero-crossing count alone cannot trigger it. |
| `uncertain_audio` | Insufficient speech/whisper evidence. Report separately instead of assigning an emotion. |

An onset is buffered for 200 ms. An isolated burst needs 150 ms of following quiet before it is reported. Whisper-like evidence requires at least 350 ms and stabilization. Established voiced speech holds through unvoiced consonants for up to 700 ms; a sustained switch to whisper can therefore take about one second. This trades instant labels for fewer false changes. Short voiced utterances below 200 ms are conservatively reported as uncertain short audio.

Turns finish after 800 ms below the calibrated gate. Long turns split at 30 seconds (`continues: true`), so frame storage stays bounded. Manual stop flushes an active turn. Silence does not dilute active-audio energy. Style duration, RMS energy, pitch evidence, clipping, uncertainty, and transcripts are summarized independently; loudness does not imply anger, urgency, or mood.

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

Values above are illustrative. Scores/labels are not calibrated confidence probabilities. dBFS is digital amplitude relative to full scale, **not calibrated sound pressure** and not a device-independent “intensity percent.” There is intentionally no `dominant_mood` field.

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

The browser automatically connects after the backend confirms the agent route. The backend sends the complete turn JSON as a user message, with separate guidance about uncertain acoustic cues, and returns the actual agent reply. Recent successful turns are included as context: up to six exchanges per session, across at most 32 sessions. A microphone restart creates a fresh session. Conversation history and delivery caches are in memory and disappear when the server restarts.

The saved Evolus agent’s behavior still applies. During live checks it returned Italian narration, including when the adapter requested English. Set the desired language in the agent’s own instructions if needed; the adapter cannot guarantee that its extra system message overrides the agent configuration. It also cannot independently audit the AMD deployment behind Evolus.

The server exposes only `/api/status`, `/api/turn`, and the browser assets. Status distinguishes a verified agent route from an actual successful completion in the current process. Requests are same-origin, size-limited, validated, and timed out. Credentials never enter the browser. Completed and concurrent retries of a turn ID reuse a cached response; a reused ID with different content is rejected. Failed calls remain retryable, and turns in one session are ordered. The cache retains 256 successful turns; production use needs durable idempotency and persistence.

Browser delivery retains failures for the Retry button. Queues disappear on reload, and capture stops at 100 undelivered turns. `Download latest JSON` saves only the currently displayed event. No hardcoded mock reply is shown in normal operation.

### Custom integration

`echosphere:frame` supplies continuous telemetry, `echosphere:audio-event` carries uncertain/transient events, `echosphere:turn` supplies completed turns, and `echosphere:response` carries the real agent reply. A different backend can register `window.echoSphere.setTurnHandler(async payload => { ... })`. Resolve only after acceptance and throw on failure. This replaces the built-in delivery handler.

A separate local JSON receiver can use `window.echoSphere.connectLocalEndpoint({url: YOUR_LOCAL_ENDPOINT})`. The helper permits only loopback HTTP(S), refuses redirects, and expects a successful HTTP status. The included server accepts same-origin requests; a separate receiver must configure its own CORS policy.

### Local ASR

This patch does not contain a speech-recognition model and does not invent a transcript. Feed cumulative recognition results from your local ASR while the turn is active:

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

## Validation and scope

- `npm test`: 33 passing automated tests cover signal regression cases, 16/44.1/48 kHz features, calibration, clipping, turn summaries, transcript ownership, capture framing, delivery retry/timeouts, the HTTP backend, agent resolution, deduplication, and conversation isolation.
- `npm run build`: builds `dist/app.js` and the self-contained `dist/echosphere.html` from source. Do not edit generated files by hand.
- `npm run test:browser`: Playwright/Chromium checks the root and standalone pages with a fake microphone and external module requests blocked. It covers microphone-to-JSON delivery, permission/device errors, startup failures, automatic agent routing with a mock provider, visible replies, mobile layout, and local-voice playback wiring with a mock voice. Direct file navigation is also checked where browser policy permits it; a policy block is explicitly reported as skipped. It never uses live credentials.
- `npm run test:live`: an explicit, optional live test. It requires the server key, Playwright, and Chromium, and makes one real agent completion. The verified path is fake microphone → AudioWorklet → detector → local HTTP backend → live Evolus agent → browser. It stops capture after the first turn to avoid repeated paid requests. Ordinary tests do not call the live API.

Browser checks require Playwright to be available to Node and Chromium at `/usr/bin/chromium` (or `CHROMIUM_PATH`). They were available in the cloud workspace and are not app runtime dependencies. The optional `.env` supports local execution; no real key is included in the project or archive.

An additional check used the public 11-second [jfk.flac fixture from OpenAI Whisper](https://github.com/openai/whisper/blob/main/tests/jfk.flac). It produced one predominantly voiced turn, no transient events, and no whisper classifications. It is not bundled and is not a whisper benchmark.

This delivers the detector/JSON/agent-response workflow from the supplied prototype. It does not yet implement a local ASR model, binaural multi-character synthesis, a continuous soundscape renderer, or directional haptic hardware. Frame events are available for those components. Acoustic analysis is local; Evolus inference is remote, so this deployment is not fully offline.

These checks are not a measured accuracy rate on real whispers/coughs or your microphone. Test quiet/loud speech, whispered sentences, sustained “s”/“f” sounds, short words, coughing, blowing, snaps, room noise, and playback on the actual device. No hardware microphone or audible speaker output was tested in the cloud. Ambiguous sounds remain explicitly uncertain instead of being labeled as emotion.
