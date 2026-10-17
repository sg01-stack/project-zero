// Optional: two REAL Evolus calls. Checks the judge's typed comparison path,
// not speech-model inference, physical audio, or a public deployment.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { createApplicationServer } from '../server/app.mjs';
import { loadRuntime } from './runtime.mjs';
import { storyPlacement } from '../src/narrative.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = await loadRuntime(root);
if (!env.EVOLUS_API_KEY) throw new Error('Configure the server key privately before running the optional live check.');
const { chromium } = createRequire(import.meta.url)('playwright');
const server = createApplicationServer({ root, env });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage(), errors = [], results = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.echoSphere?.getStatus().agentReady, {}, { timeout: 25000 });
  await page.evaluate(() => {
    window.judgeTurns = []; window.judgeReplies = [];
    window.addEventListener('echosphere:turn', event => window.judgeTurns.push(event.detail));
    window.addEventListener('echosphere:response', event => window.judgeReplies.push(event.detail));
  });
  for (const [input, output] of [['quiet', 'quietExampleResult'], ['distant', 'distantExampleResult']]) {
    const began = performance.now();
    await page.locator(`[data-story-example="${input}"]`).click();
    await page.waitForFunction(id => document.getElementById(id).textContent.startsWith('Live Evolus agent:') || window.echoSphere.getStatus().transportState === 'failed', output, { timeout: 80000 });
    assert.notEqual(await page.evaluate(() => window.echoSphere.getStatus().transportState), 'failed', await page.locator('#deliveryStatus').textContent());
    const reply = await page.locator(`#${output}`).textContent();
    const requested = await page.evaluate(() => window.judgeTurns.at(-1).transcript.text);
    results.push({ input, elapsed_ms: Math.round(performance.now() - began), reply, placement: storyPlacement(reply, storyPlacement(requested).preset) });
  }
  const { turns, replies } = await page.evaluate(() => ({ turns: window.judgeTurns, replies: window.judgeReplies }));
  await writeFile('/tmp/echosphere-judge-comparison.json', JSON.stringify(results, null, 2));
  assert.equal(turns.length, 2); assert.equal(replies.length, 2);
  assert.ok(turns.every(turn => turn.event === 'user_text' && turn.transcript.source === 'typed' && turn.prosody_analysis === null));
  assert.equal(turns[0].session_id, turns[1].session_id);
  assert.notEqual(replies[0].reply, replies[1].reply);
  assert.equal(results[0].placement.preset, 'intimate', JSON.stringify(results));
  assert.equal(results[1].placement.preset, 'hall', JSON.stringify(results));
  assert.equal(results[1].placement.options.angle, 55, JSON.stringify(results));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, real_evolus_calls: 2, path: 'Typed comparison buttons → Node backend → live Evolus → two visible responses and story-derived placements', results, speech_models_tested: false, public_host_tested: false }, null, 2));
} finally { await browser?.close(); server.closeAllConnections(); server.close(); }
