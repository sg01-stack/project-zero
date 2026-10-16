// Optional browser verification; Playwright and Chromium are already available
// in the cloud workspace. They are not required to run the application.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createApplicationServer } from '../server/app.mjs';
import { DEFAULT_AGENT_ID } from '../server/evolus.mjs';
const ROUTE = `11111111-1111-4111-8111-111111111111:${DEFAULT_AGENT_ID}`;
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const temp = await mkdtemp(join(tmpdir(), 'echosphere-browser-'));
const fixture = join(temp, 'mic.wav');
const rate = 48000, seconds = 8;
const wav = Buffer.alloc(44 + rate * seconds * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < rate * seconds; i++) {
  const t = i / rate;
  const x = t >= 2 && t < 4 ? 0.15 * (0.7 * Math.sin(2 * Math.PI * 160 * t) + 0.2 * Math.sin(2 * Math.PI * 480 * t) + 0.1 * Math.sin(2 * Math.PI * 960 * t)) : 0;
  wav.writeInt16LE(Math.round(x * 32767), 44 + i * 2);
}
await writeFile(fixture, wav);
const port = process.env.SMOKE_PORT || '8001';
const server = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: port, EVOLUS_API_KEY: '', EVOLUS_MODEL: '', EVOLUS_AGENT_ID: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
let browser;
let mockServer;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timed out')), 5000);
    server.stdout.once('data', () => { clearTimeout(timeout); resolve(); });
    server.once('error', error => { clearTimeout(timeout); reject(error); });
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
  });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fixture}`] });
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const externalRequests = [];
  page.on('request', r => { if (/^https?:/.test(r.url()) && new URL(r.url()).hostname !== '127.0.0.1') externalRequests.push(r.url()); });
  // Exercise both the source page and the actual downloadable single file.
  for (const path of ['/', '/dist/echosphere.html']) {
    await page.goto(`http://127.0.0.1:${port}${path}`);
    await page.evaluate(() => {
      window.testTurns = []; window.testDelivered = [];
      window.addEventListener('echosphere:turn', e => window.testTurns.push(e.detail));
    });
    await page.getByRole('button', { name: 'Start microphone', exact: true }).click();
    await page.waitForFunction(() => window.testTurns.length > 0, {}, { timeout: 15000 });
    assert.equal(await page.evaluate(() => window.echoSphere.getStatus().transportState), 'not_connected');
    const payload = await page.evaluate(() => window.testTurns[0]);
    assert.equal(payload.prosody_analysis.dominant_style, 'voiced_speech');
    assert.equal(payload.event, 'user_turn_complete');
    await page.evaluate(() => window.echoSphere.setTurnHandler(async p => window.testDelivered.push(p.turn_id)));
    await page.getByRole('button', { name: 'Stop microphone', exact: true }).click();
    await page.waitForFunction(() => !window.echoSphere.getStatus().running);
    const status = await page.evaluate(() => window.echoSphere.getStatus());
    assert.equal(status.queuedTurns, 0); assert.equal(status.transportState, 'delivered');
    assert.equal(await page.evaluate(() => window.testTurns.length), 1);
    assert.deepEqual(await page.evaluate(() => window.testDelivered), [payload.turn_id]);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    console.log(`PASS ${path}: microphone → AudioWorklet → detector → JSON → acknowledged handler; stop; mobile layout`);
  }
  // Microphone permission failure must leave a usable Start button.
  const denied = await browser.newContext();
  const deniedPage = await denied.newPage();
  await deniedPage.goto(`http://127.0.0.1:${port}`);
  await deniedPage.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Permission denied', 'NotAllowedError'); }; });
  await deniedPage.getByRole('button', { name: 'Start microphone', exact: true }).click();
  await deniedPage.waitForFunction(() => document.getElementById('notice').textContent.includes('Could not start:'));
  assert.equal(await deniedPage.getByRole('button', { name: 'Start microphone', exact: true }).isEnabled(), true);
  assert.equal(await deniedPage.evaluate(() => window.echoSphere.getStatus().running), false);
  console.log('PASS permission failure: clear error, microphone off, restart enabled');
  // Exercise the actual Node route with an injected agent, never the live API.
  let agentCalls = 0;
  mockServer = createApplicationServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    env: { EVOLUS_API_KEY: 'test-only-placeholder' },
    listModels: async () => [ROUTE],
    completeTurn: async (payload, selectedModel) => {
      agentCalls++;
      assert.equal(selectedModel, ROUTE);
      assert.equal(payload.event, 'user_turn_complete');
      assert.equal(payload.prosody_analysis.dominant_style, 'voiced_speech');
      return { turn_id: payload.turn_id, reply: 'Mock narrative response through the backend.' };
    },
  });
  mockServer.listen(0, '127.0.0.1'); await once(mockServer, 'listening');
  await page.goto(`http://127.0.0.1:${mockServer.address().port}`);
  await page.waitForFunction(() => window.echoSphere.getStatus().agentReady);
  assert.equal(agentCalls, 0);
  await page.getByRole('button', { name: 'Start microphone', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('agentReply').textContent === 'Mock narrative response through the backend.', {}, { timeout: 15000 });
  assert.equal(await page.evaluate(() => window.echoSphere.getStatus().transportState), 'delivered');
  await page.getByRole('button', { name: 'Stop microphone', exact: true }).click();
  await page.waitForFunction(() => !window.echoSphere.getStatus().running);
  assert.equal(agentCalls, 1);
  console.log('PASS automatic agent routing → microphone → real local backend → mocked agent → visible narrative response');
  await page.evaluate(() => {
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [{localService: true, lang: 'en-US'}], cancel: () => {},
      speak: utterance => { window.testSpoken = utterance.text; utterance.onend?.(); },
    }});
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: class { constructor(text) { this.text = text; } } });
  });
  await page.getByRole('button', { name: 'Play response · pauses microphone', exact: true }).click();
  assert.equal(await page.evaluate(() => window.testSpoken), 'Mock narrative response through the backend.');
  console.log('PASS local-voice playback integration (mock voice; hardware sound not tested)');
  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  console.log('PASS no browser script errors or external network requests');
} finally {
  await browser?.close(); server.kill(); mockServer?.closeAllConnections(); mockServer?.close(); await rm(temp, { recursive: true, force: true });
}
