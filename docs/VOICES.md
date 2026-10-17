# Voice and conversation workflow

Use the hosted HTTPS app, or the Windows launcher / `npm start` for development. The standalone file contains the visual detector, but it cannot create a secure Evolus backend or run the separately served model workers.

## Try it

1. Confirm **Live · Evolus agent**. The hosted owner sets the Evolus key; a local developer can use the setup form. Evolus Studio is unnecessary.
2. Click **Click to Initialize.**, allow microphone access, and leave the tab open for the first model downloads. Recognition and voice synthesis run locally in separate workers. No cloud voice account or manual speech-model installation is needed.
3. After **Ready**, stay quiet for the 1.2-second noise calibration. The guide begins automatically. Speak in English, check the recognized text, and pause for a response; speak during the guide's line to interrupt.
4. Use headphones. Speaking for about 200 ms after speech classification interrupts narration; the microphone keeps listening. Acoustic classification adds onset latency, so this is not a guaranteed 200 ms end-to-end response.
5. In **Voice & space**, compare Heart/Bella and Emma/George with **Audition selected voice**. Try close/distant/passing/orbiting placements. Direction and distance can change during playback. Speaking speed affects upcoming generated segments.

## What changes continuously

Microphone frames drive the visual atom, waveform, stereo ambience, and retained vocal-delivery profile every 50 ms. During conversation, a soft profile brings the narrator closer and slows upcoming speech; stronger input increases distance/room contribution and pacing slightly. Spatial updates are smoothed in Web Audio. Pauses retain the last delivery profile so the reply responds to what preceded it.

Recognition starts after a 250 ms pause and is reused only if speech did not resume before the final 650–850 ms endpoint. Words travel through Whisper and Evolus asynchronously. Story text is generated around detected pauses, not on every acoustic frame. The backend forwards streamed text; complete sentences can begin synthesis before the full reply arrives. Within a completed passage, Kokoro generates one sentence ahead while the previous sentence plays. A live provider test took 5.68 seconds to first text and 5.70 seconds total; that is one observation, not a benchmark or latency guarantee. Slow hardware may still produce gaps. This system does not infer a person's internal emotional state or implement a professional emotional acting model.

The waveform has its own slow attack/release envelope and a continuous, fixed-speed phase. Loudness changes its size gently, rather than making it jump or oscillate faster. The atom still reacts through the faster acoustic envelope.

Automatic story placement maps narrated spatial cues to bounded presets, while retained vocal delivery modulates distance and room tone. Manual controls disable automatic placement. The guide opens the story and may offer one idle prompt after 20 seconds of quiet per interaction; this can be disabled.

## Models and dependencies

- Default English recognition: [`Xenova/whisper-base.en`](https://huggingface.co/Xenova/whisper-base.en), q8, WebAssembly. The smaller [`Xenova/whisper-tiny.en`](https://huggingface.co/Xenova/whisper-tiny.en) is selectable for slower devices. A 250 ms pre-roll preserves quiet onsets. ASR-only high-pass/DC removal and gain capped at 8× help weak recordings without changing measured acoustic levels. These changes are not a measured whisper-accuracy improvement.
- English narration: [`onnx-community/Kokoro-82M-v1.0-ONNX`](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX), q8, WebAssembly; ten selectable voices.
- Browser libraries are pinned and vendored; provenance and licenses are in [`vendor/README.md`](../vendor/README.md).
- Runtime/weights are downloaded from public Hugging Face/jsDelivr hosts only on request. Browser caching is best effort; private browsing or storage eviction may cause repeat downloads.
- Synthesized or uploaded mono audio enters a Web Audio HRTF PannerNode, distance low-pass filtering and a stereo room convolver. An output compressor bounds peaks. Installed SpeechSynthesis voices are explicitly flat playback because their PCM is inaccessible to Web Audio.

## Acceptance checks still required

The cloud egress proxy currently returns HTTP 403 for Hugging Face. A draft adds the model hosts while retaining the Evolus destinations; saving that draft does not apply it. Successful real Whisper/Kokoro inference has not been verified here. No public Render URL is deployed yet.

Once model downloads are allowed, run `npm run test:models` to exercise the real workers (no Evolus credits are used). Then verify a real live agent conversation on the deployed HTTPS URL with headphones, including whispered sentences, interruption, recognition mistakes, and your target device's latency. Record the actual results before submitting the live-demo claim.

Already tested: 54 unit/integration tests; real offline Web Audio rendering for HRTF channel separation, distance attenuation and reverb tails; model-worker failure recovery; voice selection/cancellation; and the complete automatic conversation plumbing using fake microphone audio and mocked models/provider.
