# EchoSphere — project handoff

Updated 2026-10-17. Repository: `sg01-stack/project-zero`, branch `main`. Use the existing checkout at `/workspace/project-zero` in Codex. Do not create a worktree unless requested. Start with `git status` and `git log -3 --oneline`; preserve any new user work.

## User's goal

A submission-worthy hackathon project judges can open from an HTTPS link without installing dependencies, Evolus Studio, or entering their own key. The user explicitly authorized fixing the app, updating GitHub, and pushing `main`. They asked us to choose hosting; **Render** was selected. Their design request was a new look: a twinkling starfield, draggable eight-orbit atom with orbiting electrons reacting to real-time speech, a centered two-inch waveform above “Click to Initialize.”, and “Welcome To Echosphere.” below the atom. They subsequently requested eight orbits, a bold welcome title, a larger waveform, and a real automatic conversation experience. They explicitly chose free local neural voices with browser model downloads. They do not want judges to install Studio, Node, or speech software. Do not ask them to choose the technology again.

## Current state

The repository contains the full app, not just an HTML mockup. The prior Windows/Edge startup failure was an `AbortError` hidden by generic error handling; worklet rejection now triggers compatibility capture, and device startup retries with default constraints. There is a Windows launcher, local key setup, stage-specific diagnostics, cancellation, device selection, and recalibration.

The new submission build adds:

- The requested cosmic welcome screen: perspective-projected, depth-sorted eight-orbit atom with 122 electrons, pointer and keyboard rotation, 50 ms acoustic-driven animation, responsive layout, and reduced-motion support.
- Hosted mode behind HTTPS with Render/Docker configuration, host/origin checks, secure visitor cookies, isolated conversations and retry caches, and per-process/per-visitor completion budgets.
- Hosted credentials are supplied by the owner. Visitors cannot change them and never receive the key. Public setup form is hidden/disabled.
- A visible Live/Offline mode, an explicitly scripted offline scene, typed actions with no invented audio features, and three labelled synthetic feature tours that never call the LLM.
- Browser Whisper tiny.en recognition, Kokoro voices, automatic spoken replies, sustained-speech interruption, HRTF/distance/reverb processing, and vocal-delivery modulation. See docs/VOICES.md for verification limits.
- Continuous stereo ambience driven by acoustic frames, optional browser vibration preview, ten auditionable Kokoro voices, and flat system-voice fallback.
- `docs/DEPLOYMENT.md`, `docs/SUBMISSION.md`, `render.yaml`, `Dockerfile`, and a GitHub Actions test/build workflow.

## Outstanding steps — models and public hosting

The real model imports and download-failure recovery are tested, but successful Whisper/Kokoro inference is NOT verified. Hugging Face returns proxy HTTP 403 in this cloud environment. A network draft adds huggingface.co, *.huggingface.co and *.hf.co while preserving api.evolus.ai and app.evolus.ai. User application/publication is still required; saving the draft did not update the running proxy. After access is applied, run npm run test:models (real Kokoro → Whisper, no Evolus credits), then test a real conversation. Do not treat mocks as real speech recognition or voice-quality evidence.

## Public hosting

**No public URL has been deployed or verified.** Deployment files and local hosted-mode tests are not a deployment. This environment has an Evolus key but no Render/Railway/Fly hosting credential or connected deployment tool. Do not claim judges already have a live site.

The owner needs to open:

https://render.com/deploy?repo=https://github.com/sg01-stack/project-zero

Then sign in with GitHub, authorize the repository, and provide `EVOLUS_API_KEY` through Render's secret field. The preset agent ID is already in `render.yaml`. Render supplies `RENDER_EXTERNAL_URL`; custom domains need `PUBLIC_ORIGIN`. A free plan is configured to avoid an unauthorized charge; free instances can sleep/cold-start. Always-on hosting requires the owner to review a paid plan. Never guarantee flawless uptime.

After the owner provides the real HTTPS URL, verify `/api/health`, hosted UI (no judge key form), a real agent response, and browser microphone access. Add that verified URL to README and submission notes, commit, push, and verify remote `main`. Never invent a public URL or put a secret in GitHub.

## Evolus details

No Evolus Studio installation is needed. Confirmed API:

- `GET https://api.evolus.ai/v1/models`
- `POST https://api.evolus.ai/v1/chat/completions`
- Server-side `Authorization: Bearer <key>`
- Agent ID: `405d18ba-6acf-43cd-9d76-7eddb9710603`
- API route discovered from the authenticated model list: `8f6b7471-0aaf-43f0-ad70-474e17559724:405d18ba-6acf-43cd-9d76-7eddb9710603`
- Underlying Evolus label `own/gemma-4-31b-it` is NOT the API routing ID.

The backend resolves the route automatically. Reuse injected `EVOLUS_API_KEY` where present; inspect presence only, never its value. The cloud secret does not travel with a downloaded ZIP. Local users can enter a key in the app; remembered settings are excluded from Git. Do not ask for keys in chat.

Real Evolus completions have been verified with AudioWorklet capture, forced compatibility capture, first-run key setup, and a typed turn through hosted visitor/session handling. The agent returned Italian even with English system guidance. A live test using a direct English instruction preceding the intact JSON report returned English. The adapter now applies that request format; verify language again if the saved agent changes.

## Run and verify

Node.js 22+; no app npm dependencies. The cloud machine currently has Node 24 and Playwright/Chromium.

```sh
npm run start:headless
npm run build
npm test
npm run test:browser
npm run test:submission
```

`npm start` or `Start EchoSphere.cmd` also opens the local browser. Do not create Codex localhost preview links; this onboarding UI does not expose them to the user's laptop microphone.

- `npm test`: 47 tests at this handoff, covering acoustic/capture regression, local setup, persistent settings, launcher startup, hosted visitor isolation, budgets, and demo behavior.
- `test:browser`: microphone→JSON flow with synthetic microphone input; permission/cancellation/AbortError fallback; local key setup and mock agent delivery. It explicitly skips direct-file navigation if cloud browser policy blocks `file://`.
- `test:submission`: pointer/keyboard rotation, mobile first screen, voice-reactive energy, reduced-motion behavior, no-key/no-microphone offline judge flow, and a simulated HTTPS proxy with secure cookies, hosted text delivery, and hidden credential form. Provider replies are mocked in this suite.
- `test:voice`: measures actual HRTF left/right output, distance attenuation and reverb tail; real worker imports/failure recovery; mocked inference playback and cancellation.
- `test:conversation`: complete fake-microphone recognition/narration flow, automatic spatial playback, interruption and warmup cancellation. ASR/TTS/Evolus are mocked.
- `test:models`: optional real public model downloads and Kokoro → Whisper round trip; currently blocked by network policy.
- `test:live`: optional; makes one paid real completion with the configured key. `ECHOSPHERE_CAPTURE_MODE=compatibility npm run test:live` tests the fallback. Do not repeatedly spend API calls for unrelated cosmetic edits.
- Build output in `dist/` is committed. Rebuild after editing browser source. The CI checks generated output matches source.
- Docker build and non-root runtime verification passed: health endpoint, hosted secure session, page/bundle delivery, and no local credential files in the image. An image may need rebuilding in a new environment.

## Scope boundaries

This is a functional hackathon prototype with a newly integrated speech-model path, not a fully verified public product. No trained emotion classifier, multi-character director, or directional haptic hardware is included. Whisper recognition can hallucinate on noise; whisper-like acoustic labels remain tentative. Narration uses HRTF, while the background ambience uses stereo panning. Raw microphone audio stays local; live narration uses remote Evolus. Windows hardware, physical headphone localization, real speech-model accuracy/quality and the deployed HTTPS experience remain unverified. Do not guarantee flawless operation or infer emotion as fact.
