// Explicit live check: uses the configured key and one real agent completion.
// npm test and npm run test:browser never call the live service.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createApplicationServer } from '../server/app.mjs';
if (!process.env.EVOLUS_API_KEY) throw new Error('Set EVOLUS_API_KEY securely before running a live check.');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const temp = await mkdtemp(join(tmpdir(), 'echosphere-live-'));
const fixture = join(temp, 'mic.wav');
const rate = 48000;
const wav = Buffer.alloc(44 + rate * 10 * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < rate * 10; i++) {
  const t = i / rate;
  const x = t >= 2 && t < 4 ? 0.15 * (0.7 * Math.sin(2 * Math.PI * 160 * t) + 0.2 * Math.sin(2 * Math.PI * 480 * t) + 0.1 * Math.sin(2 * Math.PI * 960 * t)) : 0;
  wav.writeInt16LE(Math.round(x * 32767), 44 + i * 2);
}
await writeFile(fixture, wav);
const server = createApplicationServer({root: fileURLToPath(new URL('..', import.meta.url))});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,
    args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${fixture}`]});
  const context = await browser.newContext({permissions:['microphone']});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.echoSphere.getStatus().agentReady, {}, {timeout:25000});
  await page.evaluate(() => {
    window.liveTurns = []; window.liveResponses = [];
    window.addEventListener('echosphere:turn', event => {
      window.liveTurns.push(event.detail);
      // Exactly one completion: stop before the fake microphone file loops.
      void window.echoSphere.stop();
    });
    window.addEventListener('echosphere:response', event => window.liveResponses.push(event.detail));
  });
  await page.getByRole('button',{name:'Start microphone',exact:true}).click();
  await page.waitForFunction(() => window.liveResponses.length || window.echoSphere.getStatus().transportState === 'failed', {}, {timeout:80000});
  const result = await page.evaluate(() => ({turns: window.liveTurns, responses: window.liveResponses, status: window.echoSphere.getStatus(), delivery: document.getElementById('deliveryStatus').textContent}));
  assert.deepEqual(errors, []);
  assert.equal(result.turns.length, 1);
  assert.equal(result.responses.length, 1, result.delivery);
  assert.equal(result.responses[0].turn_id, result.turns[0].turn_id);
  assert.equal(result.turns[0].transcript, null);
  assert.equal(result.turns[0].prosody_analysis.dominant_style, 'voiced_speech');
  assert.equal(result.status.queuedTurns, 0);
  assert.equal(result.status.running, false);
  const status = await (await fetch(`http://127.0.0.1:${server.address().port}/api/status`)).json();
  assert.equal(status.live_connection_verified, true);
  await page.setViewportSize({width:1000,height:1000});
  await page.screenshot({path:'/tmp/echosphere-live-verified.png',fullPage:true});
  console.log(JSON.stringify({passed:true,path:'fake microphone -> AudioWorklet -> detector -> local HTTP backend -> live Evolus agent -> browser',turns:1,responses:1,agent_id:result.responses[0].agent_id,reply:result.responses[0].reply,transcript:null,hardware_microphone_tested:false},null,2));
} finally {
  await browser?.close(); server.closeAllConnections(); server.close(); await rm(temp,{recursive:true,force:true});
}
