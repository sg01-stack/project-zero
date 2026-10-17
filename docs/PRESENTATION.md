# EchoSphere — presentation under five minutes

Primary track: **Track 4, Create a New Kind of Experience**, AMD Developer Hackathon Act 3. This outline follows the kickoff transcript supplied by the participant. Use real recorded results; do not narrate an unverified feature as working.

## 0:00–0:30 — The audience and problem

“Interactive stories usually wait for buttons or rigid voice turns. EchoSphere is an audio-first storytelling prototype for interactive entertainment and museum-style experiences. Your voice continuously changes the atmosphere, and you can interrupt the guide while it speaks.”

Show the starfield and the sixteen-orbit atom. State that text and keyboard controls are available. Do not call the prototype fully accessible or fully local: the narrative model is remote.

## 0:30–1:40 — First input: quiet exploration

Open the actual public HTTPS URL. Models should already be warmed in the recording browser; briefly disclose the first-use download. Click Initialize, allow the microphone, stay quiet during calibration, and let the guide introduce the scene.

Whisper: “Please stay beside me and speak softly while we listen at the door.” Show the actual recognized words. If recognition misses a word, show correction through the text input rather than concealing it. Show the gentle waveform, local acoustic style, reply, and nearby spatial placement with headphones.

## 1:40–2:40 — Second input: a distant encounter

Say at a normal clear volume: “Is someone there? Let a distant voice answer from the right.” Show how the narrative and voice placement change. Speak during playback to interrupt and change direction.

The **One world. Two different inputs.** cards preserve both results for comparison. Their buttons send **typed** actions, not synthetic microphone claims. If used in the recording, identify them as the accessible typed path. Keep **Live · Evolus agent** visible; do not pass off the offline scripted scene as a generated response.

## 2:40–3:35 — Explain the technology

Show the architecture from SUBMISSION.md and a small JSON payload:

- Browser: 50 ms acoustic frames, Whisper English recognition, Kokoro speech, visual rendering, HRTF/distance/reverb.
- App server: private Evolus key, request validation, visitor history, budgets, streamed responses.
- Evolus agent: the story context and participant input go to the team's open model on AMD Developer Cloud. Show actual AMD GPU/model deployment evidence with secrets hidden.
- Local direction rules map narrated spatial cues to placement; vocal delivery modulates it continuously. These rules are authored. Narrative prose is model generated. Neither amplitude nor pitch proves an internal emotion.

Do not claim the local speech models or visual canvas run on the cloud AMD GPU. The meaningful AMD workload is narrative inference.

## 3:35–4:20 — Value, costs, and quality

Potential customers: immersive experience studios and museums that want reusable, audience-responsive audio experiences. A possible commercial model is a venue or creator subscription; this is a proposal, not validated revenue.

Present measured cost data from the actual hosting dashboards using the worksheet in SUBMISSION.md. Separate AMD GPU instance time, app hosting, and any billable Evolus platform services. Local speech has no per-request voice-provider charge but uses the visitor's device and bandwidth. Free event credits are a temporary subsidy, not permanent zero cost.

Explain quality controls: bounded narrative length, recent story history, clear recognition text, acoustic uncertainty, one idle prompt per interaction, cancellable speech, and manual placement controls. Mention the current whisper benchmark/latency limitations honestly.

## 4:20–4:50 — Finish with a usable product

Show the public demo link and GitHub link. Say that judges need a browser and headphones, not an API key or Evolus Studio. Mention the automatic model download and any free-host cold start. Close with the intended experience and one concrete next improvement supported by your demo results.

Leave a ten-second margin; rehearse and ensure the exported recording is no longer than five minutes.
