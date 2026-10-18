# EchoSphere

**Speak softly. Change the atmosphere. Explore a story shaped by how you sound.**

EchoSphere is an audio-first storytelling prototype for interactive entertainment and museum-style experiences. Your voice continuously shapes a starfield, a draggable sixteen-orbit atom, and ambient sound. A narrative guide responds through Evolus, while browser speech models recognize your words and render a spatial voice.

[Owner setup](docs/START-HERE.md) · [Deploy on Render](https://render.com/deploy?repo=https://github.com/sg01-stack/project-zero) · [Judge walkthrough](docs/SUBMISSION.md) · [Security review](docs/SECURITY-REVIEW.md)

![EchoSphere: a sixteen-orbit atom in a starfield above the welcome message](docs/preview.png)

> **Demo status:** deployment configuration is included; a public demo URL has not yet been deployed or verified. Real Evolus responses have been tested. Successful browser Whisper/Kokoro inference remains unverified in the development environment because its proxy denies model downloads, even after the network settings were published.

## The experience

- **A responsive world:** 222 electrons orbit sixteen interactive planes. Drag to rotate, or use the arrow keys. A gently eased waveform and stereo ambience follow your vocal delivery.
- **A guide who takes the lead:** the opening begins automatically when conversation is ready. Speak during narration to interrupt, or ask the guide to continue.
- **Spatial narration:** ten selectable Kokoro voices, binaural HRTF placement, distance filtering, and room reflections. Authored story-cue rules position the guide close by, across the room, or moving around you.
- **Local audio processing:** contiguous 50 ms frames drive acoustic controls. Whisper recognizes English speech in the browser; Kokoro generates speech there too. Recognized text and acoustic summaries go to the narrative agent.
- **Alternative ways to participate:** typed actions, keyboard controls, reduced motion, and an explicitly labelled offline scripted scene.

Acoustic feedback is continuous. Story generation follows detected pauses and depends on recognition, model, and device latency. Vocal delivery influences the soundscape and narration settings; EchoSphere does not claim to read emotion or reason about every word every 50 ms.

## Try the hosted experience

Once the owner deploys the app, judges need **a browser and the public HTTPS link**. They do not install Evolus Studio or Node.js, and they do not supply an API key.

1. Open the deployed website and use headphones. Open **Story & controls** to check the agent connection.
2. Click **Click to Initialize.** and allow microphone access. Wait for the browser speech models to load, then stay quiet for the 1.2-second calibration.
3. Let the guide begin. Try “Please stay beside me and speak softly,” then “Let a distant voice answer from the right.” Check the recognized words and compare the story and spatial placement.
4. Speak during a reply to interrupt it. Explore voices under **Voice & space**.

First use downloads several hundred MB of model/runtime assets; later visits may reuse the browser cache. Speed depends on the device and network. The two written comparison inputs work without speech-model downloads. **Try offline scene** provides scripted storytelling when the agent is unavailable; it is clearly distinguished from live AI.

## Deploy your own demo

Use the [click-by-click Render guide](docs/START-HERE.md#2-create-the-website-judges-will-open). Render serves the page and Node backend together over HTTPS; GitHub Pages alone cannot run this backend.

1. [Create the Render service](https://render.com/deploy?repo=https://github.com/sg01-stack/project-zero) from branch `main` using the included `render.yaml`.
2. Add `EVOLUS_API_KEY` only in Render's private environment settings. Keep the preset agent ID for this project's agent, or replace it with your own configured agent.
3. After the service is **Live**, test its agent connection and a complete voice conversation. Share that verified HTTPS address alongside this repository.

The preset uses Render's free plan, which can sleep. The AMD model and Evolus workspace must remain available during judging. Hosting credentials saved in a coding environment are not transferred to Render. See [deployment configuration and limits](docs/DEPLOYMENT.md).

**Hackathon fit:** based on the supplied AMD Developer Hackathon Act 3 kickoff transcript, Render can host the app while meaningful narrative inference runs on AMD. The submission targets **Track 4: Create a New Kind of Experience**. Record evidence of the AMD deployment and demonstrate two different inputs. Final eligibility belongs to the organizers. The separate Evolus Business Agents challenge requires a business process and at least two platform building blocks; this integration currently uses one agent. See [submission notes](docs/SUBMISSION.md) and [the building-block explanation](docs/EVOLUS-BUILDING-BLOCKS.md).

## Run locally

Install [Node.js 22 or newer](https://nodejs.org/), then:

```sh
git clone https://github.com/sg01-stack/project-zero.git
cd project-zero
npm start
```

No `npm install` step is needed to run the app. On Windows, extracting the complete repository ZIP and double-clicking **Start EchoSphere.cmd** does the same thing. Keep the terminal open.

In the local app, enter your own key under **Your narrative agent** and choose **Connect and test agent**. Alternatively, copy `.env.example` to `.env` and fill in the key locally. The backend discovers the Evolus agent's API routing ID; the underlying Gemma model label is not that routing ID. For your own agent, set `EVOLUS_AGENT_ID` too.

Opening `index.html` directly cannot start the backend or the complete conversation workflow. Use the launcher or `npm start`. `npm run start:headless` runs the server without opening a browser.

## Where the work runs

| Component | Location | Purpose |
| --- | --- | --- |
| Audio capture, acoustic detector, visuals and ambience | Visitor's browser | Continuous feedback while speaking |
| Whisper base.en / optional tiny.en | Browser worker, model downloaded on first use | English speech recognition |
| Node backend | Render or the developer's computer | Keeps the API key server-side, validates turns, isolates visitors and forwards responses |
| Evolus agent and configured AMD-hosted open model | Evolus / owner's AMD deployment | Generates narrative text using words, acoustic context and recent story history |
| Kokoro and Web Audio | Visitor's browser | Neural speech, HRTF positioning, distance and room effects |

Raw microphone audio stays in the browser. Recognized words and acoustic summaries are sent to the backend and Evolus for live narration. The live experience is therefore **not fully offline**. The API connection has been tested; independent evidence of the underlying GPU must come from the AMD deployment. [Architecture and submission evidence →](docs/SUBMISSION.md)

## Credentials and privacy

The review on **2026-10-18** found no real credentials in the current files or available Git history. Hosted mode disables visitor credential changes; the backend does not serve `.env`, saved settings, server source, or Git metadata. The committed `.env.example` and Render configuration contain no key values. [Read the review, scan scope and limitations](docs/SECURITY-REVIEW.md).

Keep keys out of commits, screenshots and chat. Revoke and replace any key previously shared outside a secret store. Local **Remember on this computer** uses an ignored plain-text settings file with owner-only permissions where supported; it is not an encrypted vault.

The public demo limits real agent calls to **60 per hour per running process** and **20 per visitor** by default. These in-memory limits reset on restart and are not a billing guarantee. Conversation history is also bounded and held in memory; Evolus and the hosting provider have their own data-handling policies.

## Validation and current limits

```sh
npm test
npm run build
```

**54 automated tests pass**, covering acoustic regression cases, turn delivery, streaming/cancellation, local setup, credential privacy, visitor isolation and usage limits. Build output is committed in `dist/`; rebuild after editing browser source.

| Check | Scope / result |
| --- | --- |
| `test:browser`, `test:submission` | Passed with synthetic microphone audio and a mocked provider; includes hosted-mode UI and permission handling. Direct-file navigation was skipped where cloud browser policy blocked it. |
| `test:voice`, `test:conversation` | Passed: real Web Audio spatial rendering and conversation wiring; recognition/synthesis are mocked. |
| `test:live`, `test:judge-live` | Passed against real Evolus, including two written quiet/distant scenarios. These consume provider calls and do not verify speech-model inference. |
| `test:models` | **Blocked:** actual Kokoro → Whisper check fails to download models through the active cloud proxy. Published network settings contain the required hosts; successful inference is still unverified. |
| Public HTTPS demo and physical microphone/headphones | **Pending:** verify on the actual deployed site before submitting the live-demo claim. |

Run optional checks with `npm run <check>`. Browser checks need Playwright and Chromium; see [development and verification details](HANDOFF.md#run-and-verify). They are not runtime requirements for judges.

Whisper accuracy on real whispered speech has not been benchmarked. Quiet-input gain and pre-roll are implemented, but recognition can still fail or hallucinate on noise. The detector uses acoustic heuristics, not a trained emotion model. This prototype has one spatial narrator and optional browser vibration, rather than a multi-character director or directional haptic hardware. Provider replies can take seconds; no instant-response or universal-device guarantee is made.

## Project guide

- [Owner setup, deployment and submission links](docs/START-HERE.md)
- [Voice models, spatial controls and acceptance checks](docs/VOICES.md)
- [Audio events, JSON schema and custom integration](docs/INTEGRATION.md)
- [Submission description, AMD evidence and cost worksheet](docs/SUBMISSION.md)
- [Presentation outline: at most five minutes](docs/PRESENTATION.md)
- [Security review](docs/SECURITY-REVIEW.md) · [Third-party provenance and licenses](vendor/README.md)

The full page is in `index.html`, styling in `style.css`, browser code in `src/`, and the backend in `server/`. Generated files in `dist/` should not be edited by hand.
