# Credential and public-demo review

Reviewed on **2026-10-18** before publishing the repository. This is a scoped engineering review, not a penetration test, certification, or guarantee of zero risk.

## Result

**No real credentials were found in the reviewed working tree or reachable Git history.** The review supports publishing this source with credentials kept in the hosting environment. It does not verify that a previously shared key has been revoked, audit the downstream agent's tools, or certify a public Render deployment that does not yet exist.

## What was checked

- All seven commits reachable in the non-shallow checkout through application commit `79c35880f57d6119a76a8c66a2bc9941fa6ed907`, including 138 unique historical blobs; publication documentation is scanned again before push.
- Credential patterns for Evolus, GitHub, OpenAI-style keys, AWS, Google, Slack and private-key material, plus historical credential-file names. No matches indicating real credentials were found.
- Gitleaks **8.24.3**, downloaded from its official release and verified against the published SHA-256 checksum, on Git history and the current tree. The current-tree scan also includes an explicit Evolus-key rule.
- Both Gitleaks scans reported **two generic-key warnings** in the minified tokenizer bundles. Inspection located JavaScript property accesses for the unknown-token/vocabulary implementation, not secret string values. The vendor files match the SHA-256 values recorded in [vendor/README.md](../vendor/README.md). These warnings were reviewed as false positives; the scans are not described as having zero raw findings.
- Browser source, generated bundles, the README preview image, server responses/errors, environment examples, Render/Docker configuration and CI configuration. The real key is passed by the backend only to the fixed HTTPS Evolus API; it is not embedded in the browser bundle or LLM prompt.

This covers the repository history available in this checkout. It does not cover deleted remote branches, old releases, forks, account dashboards, provider logs or other places where a key may have been shared. No key value or unredacted scanner report is committed with this review.

## Verified application boundaries

`npm test` passed **54 tests**, including:

- No credentials in status/setup responses; upstream errors do not relay private provider response bodies.
- Explicitly allowed browser assets; requests for `.env`, saved settings, server files and `.git/config` return 404.
- Hosted credential changes return 403. A visitor cannot replace the owner's key.
- Host/origin validation, JSON size/shape limits, HTTPS-origin configuration and secure HTTP-only visitor cookies.
- Conversation and retry-cache isolation between visitors; completion limits and deduplicated retries.

These checks use synthetic credentials and controlled provider responses. Real Evolus requests were verified separately. A fresh public-host check is still required after deployment.

`.env` and `.echosphere.local.json` are ignored by Git and excluded from the Docker build context. `.env.example` intentionally contains an empty key field. `render.yaml` requests `EVOLUS_API_KEY` with `sync: false`, without a value. Agent/model routing identifiers in the code are identifiers, not authentication secrets.

## Before making the demo public

1. **Revoke any key previously pasted into chat or another non-secret location**, if that has not already been done. Put its replacement directly in the host's private environment settings. A clean repository scan cannot revoke a shared key.
2. Deploy using the existing hosted configuration. Keep the key in Render's environment settings, never in source, build arguments, the README, or a browser configuration file. Judges do not need a key.
3. Check the live URL from a fresh browser session: no key-entry form, a working agent response, then a complete microphone/recognition/narration flow. Local tests do not certify the deployed service.
4. Keep an eye on AMD/Evolus usage during public judging. Stop the demo or remove its hosting credential after it is no longer needed.

## Remaining risks and limits

**Public usage costs:** anyone who can open the demo can request a story. Limits are 60 real agent completions/checks per hour per process and 20 per visitor by default, with a maximum of four pending turn calls. They are in memory, reset on restart, and do not aggregate across instances. A visitor can discard their cookie to bypass the visitor allowance; the process-wide budget still applies. Use one instance for this demo. These controls are not account-level spending caps or comprehensive abuse protection.

**Third-party availability and data:** Render's free instance can sleep; the AMD endpoint, Evolus workspace, model hosts and visitor device must remain available. Raw microphone PCM stays in the browser, while recognized text/acoustic summaries and recent story context go to Evolus. Provider retention and downstream agent tool permissions require their own review. Do not use an agent with sensitive business tools for an anonymous story demo.

**Local storage and dependencies:** optional remembered local credentials use an ignored plain-text file with owner-only permissions where supported. They are not encrypted at rest by this app. Browser libraries are pinned and vendored, and model/runtime assets are downloaded on request. This review is not a dependency vulnerability audit.

**Outstanding functional verification:** the published cloud allowlist contains the required model hosts, but the running environment still receives a proxy 403 from Hugging Face and the real model test fails to fetch. Successful Whisper/Kokoro inference, real whispered-speech accuracy, and the public HTTPS conversation must still be checked. Credential review and functional readiness are different results.
