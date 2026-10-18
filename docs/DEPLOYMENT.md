# Put the judge demo online

For click-by-click instructions, start with [START-HERE.md](START-HERE.md).

Use **Render** for one HTTPS link that serves both the page and the backend. Judges need a browser; they do not install Node.js or Evolus Studio, and they do not enter an API key.

The [pre-publication credential review](SECURITY-REVIEW.md) found no real keys in the current files or reviewed Git history. Use a replacement for any previously shared key, and keep it only in the hosting service's private environment settings. Public requests can consume the owner's model allowance; the usage limits below reduce exposure but do not guarantee a bill cap.

Render hosts the app, while the configured AMD deployment performs narrative inference. This is consistent with the supplied kickoff's meaningful-AMD-workload requirement; [submission notes](SUBMISSION.md) explain the track and evidence needed. Organizers determine final eligibility.

## Owner setup — once

1. Open [Deploy EchoSphere on Render](https://render.com/deploy?repo=https://github.com/sg01-stack/project-zero).
2. Sign in to Render with GitHub and authorize access to this repository if prompted. Render reads `render.yaml` and creates a web service.
3. Enter your replacement `EVOLUS_API_KEY` in Render's secret environment-variable field. It must have access to the configured EchoSphere agent. Keep the preset agent ID. Do not paste the key into GitHub, the submission text, or chat.
4. Create/deploy the service. After its status becomes **Live**, open its `https://…onrender.com` address.
5. Click **Test agent connection** and confirm a real reply. Then click **Click to Initialize.**, allow microphone access, and wait for the browser speech-model downloads. After Ready and calibration, verify recognized words, a spoken reply, and interruption. Submit this HTTPS address alongside the GitHub repository.

The judge uses the deployed page, not a downloaded `index.html` or the GitHub source viewer. The owner configures the Evolus key once in Render; judges never need it. Evolus Studio is not involved in this web API connection.

The page downloads Whisper/Kokoro weights and runtime assets directly to the visitor's browser on request. No model server or Python installation is needed. Visitors need access to `huggingface.co`, its `*.hf.co` download hosts, and `cdn.jsdelivr.net`. Initial downloads can be several hundred MB with the default base English recognizer. Warm the models before a timed presentation, and verify on the target browser; no instant first-load or arbitrary-device latency guarantee is made.

The free plan is selected to avoid an unexpected charge. Free instances can sleep when idle and need time to wake. If an instant, always-on judging link is required, select an appropriate paid instance in Render after reviewing its price. Neither hosting nor the Evolus service can be guaranteed flawless or uninterrupted. The offline scene remains usable when live narration is unavailable, once the page has loaded.

**Deployment status:** configuration in GitHub is not an actual deployment. A hosting account, repository authorization, and the secret must be provided before a public URL exists. No public deployment is claimed by this repository.

## Configuration

| Variable | Meaning |
| --- | --- |
| `ECHOSPHERE_HOSTED=true` | Bind to `0.0.0.0`, restrict requests to the public origin, and disable visitor key changes. |
| `RENDER_EXTERNAL_URL` | Render sets the HTTPS app origin automatically. |
| `PUBLIC_ORIGIN` | Set to the exact HTTPS origin when using another host or a custom domain. Overrides the Render origin. No path/query. |
| `PORT` | Supplied by the host. The server binds this port without opening a browser. |
| `EVOLUS_API_KEY` | Server-side secret, owned by the project submitter. |
| `EVOLUS_AGENT_ID` | Defaults to the EchoSphere agent already configured in this project. |
| `MAX_AGENT_CALLS_PER_HOUR` | Default 60 real completions/checks per hour across this process, plus 20 per visitor. Cached retries do not consume additional calls. |

Hosted visitors receive a secure, HTTP-only session cookie. Their conversation histories and retry caches are isolated. The key setup endpoint is disabled in hosted mode. The host must preserve the public `Host` header when proxying HTTPS to the Node service. Health checks use `/api/health` and never invoke the model.

This is designed for **one demo instance**. Sessions, histories, and rate limits reset on restart. Use persistent shared storage and stronger abuse controls before scaling into a public product. The limits reduce accidental usage; they are not a complete billing or abuse-prevention system.

## Docker alternative

Build with `docker build -t echosphere .`, then run behind a TLS reverse proxy with `ECHOSPHERE_HOSTED=true`, `PUBLIC_ORIGIN`, and `EVOLUS_API_KEY` supplied by your host's secrets mechanism. Route HTTPS to container port 8000. The image runs as a non-root user and does not copy local credential files. Do not use build arguments for secrets.

## Troubleshooting

- **Invalid application host:** `PUBLIC_ORIGIN` must match the browser URL, including any custom domain. Check proxy Host forwarding.
- **No live narration:** inspect the server's secret configuration; use Test agent connection. A working microphone does not establish API access.
- **Key setup form hidden:** this is expected online. Only the service owner configures hosted credentials.
- **Microphone unavailable:** use HTTPS, browser microphone permission, and the correct input device. Text input and the synthetic signal tour remain available.
- **Hourly limit reached:** use the labelled offline scene or wait for the limit window; the owner can adjust the cap.

The AMD-hosted model must also remain online and your Evolus workspace/credits must stay valid throughout judging. Render hosts the app backend, not the AMD GPU model. Verify the current expiry in the account dashboard; the supplied kickoff transcript gives conflicting expiry dates.
