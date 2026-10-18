# EchoSphere — six-slide presentation

**Target: 4 minutes 10 seconds. Hard limit: 4 minutes 30 seconds.**

[PowerPoint](presentation/EchoSphere-Pitch.pptx) · [PDF](presentation/EchoSphere-Pitch.pdf)

The PowerPoint has editable text/vector diagrams, presenter notes and slide timings totaling 250 seconds. Use the PDF for consistent display. The spoken script below is 453 words; rehearse once and keep the final 20 seconds as a buffer. No live demo segment is included in this timing.

| Slide | Topic | Time | Duration |
| --- | --- | --- | --- |
| 1 | EchoSphere | 0:00–0:25 | 25 seconds |
| 2 | Who it is for | 0:25–0:55 | 30 seconds |
| 3 | The problem it addresses | 0:55–1:30 | 35 seconds |
| 4 | What it does | 1:30–2:15 | 45 seconds |
| 5 | The role of technology | 2:15–3:10 | 55 seconds |
| 6 | Two inputs. A different world. | 3:10–4:10 | 60 seconds |

## 1. EchoSphere — 0:00–0:25

EchoSphere explores a simple idea: your voice should do more than choose the next line of a story. It should shape the world around you. We combine continuous audio feedback with a narrative guide, using an Evolus agent connected to Gemma on AMD Developer Cloud.

**Presenter cue (not spoken):** Open on the title. Emphasize the three technology names; no live app switch is needed.

## 2. Who it is for — 0:25–0:55

We are building for immersive studios, museums, and creators of interactive audio. They create the worlds; visitors and listeners explore them. The aim is to make one story world respond differently to each participant, while offering voice, text, and keyboard controls. Our proposed business model is a creator or venue subscription. That is a customer hypothesis we still need to validate.

**Presenter cue (not spoken):** Point from the two creator/customer cards to the participant card.

## 3. The problem it addresses — 0:55–1:30

A transcript captures what we say, but loses much of how we say it. The same words can arrive softly, loudly, or with long pauses. A story driven only by text has no direct signal for those differences. And if every reaction waits for a completed turn, the world can feel unresponsive while we speak. EchoSphere separates immediate acoustic feedback from slower narrative reasoning.

**Presenter cue (not spoken):** Use the two waveforms to illustrate delivery only. Do not assign emotions to either waveform.

## 4. What it does — 1:30–2:15

The experience opens in a starfield around a draggable, sixteen-orbit atom. While you speak, local audio frames change the visuals and ambience. A slower, parallel path recognizes your words and sends them, with acoustic context, to the narrative agent. The guide leads the story, and you can interrupt it. Browser-generated speech passes through spatial positioning, distance filtering, and room effects. Story cues choose the placement, while vocal delivery modulates it. Words move the plot; the way you speak shapes the atmosphere.

**Presenter cue (not spoken):** The screenshot is the real app interface. Describe the implemented paths; do not imply that a live speech-model acceptance test has passed.

## 5. The role of technology — 2:15–3:10

Each technology has a distinct role. AMD Developer Cloud hosts the meaningful compute workload: narrative inference. The configured Gemma open model generates the story language using participant input and recent context. Evolus provides the agent and API connection around that model. Our Node backend keeps the credential on the server and forwards streamed responses. In the browser, Whisper handles recognition, Kokoro generates speech, and Web Audio positions that speech in space. The detector, interface, and placement rules are our authored work; narrative prose is model generated. Render hosts the web app, while the narrative model remains on AMD.

**Presenter cue (not spoken):** Show the actual AMD deployment/model evidence separately with secrets hidden if available. Do not name a GPU SKU, ROCm version, or serving stack that has not been verified.

## 6. Two inputs. A different world. — 3:10–4:10

We have tested two written inputs against the real Evolus agent. A quiet request produced a guide right beside the listener; a distant encounter produced a reply from the far right. The local director mapped those replies to different spatial presets. These are real text responses, not proof of microphone recognition. Fifty-four automated tests pass, including audio and backend checks. Our remaining acceptance steps are successful real Whisper and Kokoro inference, followed by the public HTTPS voice demo. Costs come from AMD compute, hosting, and any billable Evolus services; cost per session is not yet measured. EchoSphere's goal is simple: turn listening into participation.

**Presenter cue (not spoken):** These examples are from the documented live typed comparison. Keep the verification line visible. Finish by 4:10; the remaining 20 seconds are a buffer, not another demo segment.

## Before recording

- Rehearse with a timer; aim to finish at 4:10. Do not add an unplanned live demo to this script.
- PowerPoint: use Slide Show → Use Timings for the prepared 250-second schedule, or advance manually while following the timestamps. PDF: use full-screen mode and advance at those times.
- The quiet/distant examples come from real typed Evolus tests documented in [SUBMISSION.md](SUBMISSION.md). Distances are spatial-renderer settings, not measured physical localization. Input quotes on the slides are abbreviated for readability.
- The configured model label is `own/gemma-4-31b-it`. The owner reports that it runs on AMD Developer Cloud. Collect actual GPU/model-server evidence before submission; do not invent a GPU SKU, ROCm version or serving stack.
- Keep the final validation line until real Whisper/Kokoro inference and the public voice demo pass. Update it only with observed results.
- No public demo URL exists in this deck. The source link is real; confirm repository visibility before judging. No API keys, private endpoints or provider credentials are included.
- Cost per experience and customer demand remain unmeasured. A creator/venue subscription is a proposal.
- Build with Python 3 and `python-pptx`: `python3 docs/presentation/build_deck.py`. Export the resulting PowerPoint to PDF using PowerPoint or LibreOffice. These are presentation-authoring dependencies, not app runtime requirements.
