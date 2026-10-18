# EchoSphere — project handoff

Updated 2026-10-18 (client date). Repository: `sg01-stack/project-zero`, branch `main`. Use the existing checkout at `/workspace/project-zero` in Codex. Do not create a worktree unless requested. Start with `git status` and `git log -3 --oneline`; preserve any new user work.

## User's goal

A submission-worthy hackathon project judges can open from an HTTPS link without installing dependencies, Evolus Studio, or entering their own key. The user explicitly authorized fixing the app, updating GitHub, and pushing `main`. They asked us to choose hosting; **Render** was selected. Their design request was a new look: a twinkling starfield, draggable sixteen-orbit atom with orbiting electrons reacting to real-time speech, a centered two-inch waveform above “Click to Initialize.”, and “Welcome To Echosphere.” below the atom. The current request is sixteen orbits, a bold welcome title, a slow elegant waveform, stronger whisper transcription, a guide-led story, fast interruptions, and scene placement that follows narrative context. They explicitly chose free local neural voices with browser model downloads. They do not want judges to install Studio, Node, or speech software. Do not ask them to choose the technology again.

## Current state

The repository contains the full app, not just an HTML mockup. The prior Windows/Edge startup failure was an `AbortError` hidden by generic error handling; worklet rejection now triggers compatibility capture, and device startup retries with default constraints. There is a Windows launcher, local key setup, stage-specific diagnostics, cancellation, device selection, and recalibration.

The new submission build adds:

- The requested cosmic welcome screen: perspective-projected, depth-sorted sixteen-orbit atom with 222 electrons, pointer and keyboard rotation, 50 ms acoustic-driven animation, responsive layout, and reduced-motion support.
- Hosted mode behind HTTPS with Render/Docker configuration, host/origin checks, secure visitor cookies, isolated conversations and retry caches, and per-process/per-visitor completion budgets.
- Hosted credentials are supplied by the owner. Visitors cannot change them and never receive the key. Public setup form is hidden/disabled.
- A visible Live/Offline mode, an explicitly scripted offline scene, typed actions with no invented audio features, and three labelled synthetic feature tours that never call the LLM.
- Browser Whisper base.en by default (tiny.en selectable), ASR-only bounded gain/DC removal, 250 ms pre-roll, early recognition at a short pause, Kokoro voices, automatic streamed spoken replies, sustained-speech interruption, HRTF/distance/reverb processing, and vocal-delivery modulation. See docs/VOICES.md for verification limits.
- Continuous stereo ambience driven by acoustic frames, optional browser vibration preview, ten auditionable Kokoro voices, and flat system-voice fallback.
- `docs/DEPLOYMENT.md`, `docs/SUBMISSION.md`, `render.yaml`, `Dockerfile`, and a GitHub Actions test/build workflow.

## Latest submission requirements

The user pasted the complete AMD Developer Hackathon Act 3 kickoff transcript. EchoSphere fits **Track 4: Create a New Kind of Experience**: show at least two different inputs/audiences/situations, explain authored vs generated work, quality, costs and who pays. Added quiet/distant typed comparison cards (no fabricated acoustic input), docs/START-HERE.md, docs/PRESENTATION.md, and a cost/evidence worksheet in docs/SUBMISSION.md. The presentation must be at most five minutes. Confirm the actual deadline in the LabLab form; the transcript names noon for on-site submissions and gives conflicting workspace expiry dates.

The phrase “at least two Evolus building blocks” is specific to the separate Evolus Business Agents challenge: agent plus knowledge library/workflow/tool/etc, alongside a business process. This app uses one Evolus agent; its browser models and AMD endpoint do not count as a second platform component. Do not claim that prize eligibility. See docs/EVOLUS-BUILDING-BLOCKS.md. Twitch and YouTube fetches are blocked; use the supplied transcript, not invented video observations.

The guide now requests an opening during model loading, supports one automatic nudge after 20 seconds of idle per interaction, and can be continued manually. The backend supports SSE from Evolus and NDJSON to the browser; complete sentences can start synthesis before the full reply finishes. Barge-in aborts obsolete provider work and stops old audio. Scene-cue rules automatically choose placement; manual controls disable automatic placement. Histories persist across microphone restart within the same tab.

A real streamed opening returned English, with first text at 5680 ms and total 5701 ms; most chunks arrived together. Do not claim instant semantic response or that streaming fixes the AMD/provider latency. The fake-microphone live HTTP/streamed backend test also returned English.

Final `test:judge-live` passed with two real typed-input responses: quiet “right here by your side” -> intimate (0.65 m); distant “from the far right” -> hall (7 m, 55° right). Whole browser request times were 4098 and 3092 ms, excluding ASR/TTS. Live checks exposed a director bug: background echoes should not move a nearby narrator away. The director now preserves near distance through ambient echoes, handles at/by-your-side and far-left/right cues, and uses the participant's words as placement context. Real generated examples are covered by deterministic regressions. Do not call these physical-audio or model-inference tests.

## Outstanding steps — models and public hosting

The real model imports and download-failure recovery are tested, but successful Whisper/Kokoro inference is NOT verified. On 2026-10-18, the user published the network settings and the configuration tool confirmed no pending draft and the required model hosts in the new base version. The Evolus secret binding remains restricted to api.evolus.ai. Nevertheless the active runner still receives a proxy HTTP 403 from Hugging Face, and the retried npm run test:models fails to fetch. Do not tell the user they failed to publish or ask them to re-enter the same key/settings. A fresh task on the published environment may refresh its network policy; otherwise verify models on the deployed site. Run npm run test:models (real Kokoro → Whisper, no Evolus credits) when access works, then test a real conversation. Do not treat mocks as real speech recognition or voice-quality evidence.

## Publication review

The owner requested a credential review before making GitHub public and deploying Render. All seven reachable commits through 79c3588 and 138 unique blobs were checked with credential-pattern scans. Gitleaks 8.24.3 (official archive checksum verified) reviewed history and the current tree; its two tokenizer-code warnings are inspected false positives, not key literals. No real credentials or historical private credential files were found. All 54 tests passed, including hosted credential privacy, blocked secret-file access, visitor isolation and usage limits. README now leads with the experience, deployment and verified limits; technical detail moved to docs/INTEGRATION.md and the scoped review is in docs/SECURITY-REVIEW.md. Scan the documentation changes before pushing. Do not promise zero risk, claim a shared key was revoked, change repository visibility, or deploy a paid service without authorization. The owner plans to handle public visibility and Render after this review.

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

- `npm test`: 54 tests at this handoff, covering acoustic/capture regression, local setup, persistent settings, launcher startup, hosted visitor isolation, budgets, and demo behavior.
- `test:browser`: microphone→JSON flow with synthetic microphone input; permission/cancellation/AbortError fallback; local key setup and mock agent delivery. It explicitly skips direct-file navigation if cloud browser policy blocks `file://`.
- `test:submission`: pointer/keyboard rotation, mobile first screen, voice-reactive energy, reduced-motion behavior, no-key/no-microphone offline judge flow, and a simulated HTTPS proxy with secure cookies, hosted text delivery, and hidden credential form. Provider replies are mocked in this suite.
- `test:voice`: measures actual HRTF left/right output, distance attenuation and reverb tail; real worker imports/failure recovery; mocked inference playback and cancellation.
- `test:conversation`: guide-led opening, fake-microphone recognition/narration flow, discarding speculative fragments when speech resumes, streamed replies, automatic scene placement, spatial playback, interruption and warmup cancellation. ASR/TTS/Evolus are mocked.
- `test:models`: optional real public model downloads and Kokoro → Whisper round trip; currently blocked by network policy.
- `test:judge-live`: optional two real Evolus calls for the quiet/distant comparison. It checks actual story cues and records responses at /tmp/echosphere-judge-comparison.json; it does not test speech inference or a deployed public host.
- `test:live`: optional; makes one paid real completion with the configured key. `ECHOSPHERE_CAPTURE_MODE=compatibility npm run test:live` tests the fallback. Do not repeatedly spend API calls for unrelated cosmetic edits.
- Build output in `dist/` is committed. Rebuild after editing browser source. The CI checks generated output matches source.
- Docker build and non-root runtime verification passed: health endpoint, hosted secure session, page/bundle delivery, and no local credential files in the image. An image may need rebuilding in a new environment.

## Scope boundaries

This is a functional hackathon prototype with a newly integrated speech-model path, not a fully verified public product. No trained emotion classifier, multi-character director, or directional haptic hardware is included. Whisper recognition can hallucinate on noise; whisper-like acoustic labels remain tentative. Narration uses HRTF, while the background ambience uses stereo panning. Raw microphone audio stays local; live narration uses remote Evolus. Windows hardware, physical headphone localization, real speech-model accuracy/quality and the deployed HTTPS experience remain unverified. Do not guarantee flawless operation or infer emotion as fact.
