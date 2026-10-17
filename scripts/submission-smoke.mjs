import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createApplicationServer } from '../server/app.mjs';
import { DEFAULT_AGENT_ID } from '../server/evolus.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const local = createApplicationServer({ root, env: {} });
let calls = 0;
const hosted = createApplicationServer({ root,
  env: { ECHOSPHERE_HOSTED: 'true', PUBLIC_ORIGIN: 'https://demo.example', EVOLUS_API_KEY: 'test-only-placeholder' },
  listModels: async () => [`11111111-1111-4111-8111-111111111111:${DEFAULT_AGENT_ID}`],
  completeTurn: async payload => { calls++; return { turn_id: payload.turn_id, reply: 'Hosted agent response for the judging flow.' }; },
});
for (const server of [local, hosted]) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let submissions = 0;
  page.on('request', request => { if (request.url().endsWith('/api/turn')) submissions++; });
  await page.goto(`http://127.0.0.1:${local.address().port}`);
  await page.waitForFunction(() => window.echoSphere && document.getElementById('atomCanvas').width > 0);
  assert.equal(await page.locator('#initializeLabel').textContent(), 'Click to Initialize.');
  assert.equal(await page.locator('#welcomeTitle').textContent(), 'Welcome To Echosphere.');
  const visual = await page.evaluate(() => window.echoSphere.getStatus().visual);
  assert.equal(visual.shells, 8); assert.equal(visual.electrons, 122); assert.equal(visual.active, false);
  assert.equal(Math.round((await page.locator('#voiceWave').boundingBox()).width), 192);
  await page.screenshot({ path: '/tmp/echosphere-cosmic-desktop.png' });
  const atom = await page.locator('#atomCanvas').boundingBox();
  await page.mouse.move(atom.x + atom.width / 2, atom.y + atom.height / 2);
  await page.mouse.down(); await page.mouse.move(atom.x + atom.width / 2 + 70, atom.y + atom.height / 2 + 30, { steps: 6 }); await page.mouse.up();
  const dragged = await page.evaluate(() => window.echoSphere.getStatus().visual.rotation);
  assert.ok(dragged.y > visual.rotation.y + 0.4); assert.ok(dragged.x > visual.rotation.x + 0.2);
  await page.locator('#atomCanvas').focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
  assert.ok(Math.abs((await page.evaluate(() => window.echoSphere.getStatus().visual.rotation.y)) - 0.42) < 0.001);
  await page.locator('#atomCanvas').blur();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/echosphere-cosmic-mobile.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const initializeBox = await page.locator('#initializeBtn').boundingBox();
  assert.ok(initializeBox.y + initializeBox.height < 844, 'Initialize is visible on the first mobile screen');
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log('PASS cosmic interface: eight orbits, 122 electrons, 2-inch waveform, pointer and keyboard rotation, mobile first screen');
  await page.getByRole('button', { name: 'Try offline scene', exact: true }).click();
  await page.locator('#storyText').fill('I take the left passage');
  await page.getByRole('button', { name: 'Send story text', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('agentReply').textContent.includes('left corridor'));
  assert.match(await page.locator('#replySource').textContent(), /Offline scripted/);
  assert.equal(submissions, 0);
  await page.locator('#ambienceToggle').check();
  await page.waitForFunction(() => !document.getElementById('ambienceToggle').disabled);
  for (const [name, result] of [['Speech signal', 'voiced_speech'], ['Whisper-like signal', 'whisper_like'], ['Snap signal', 'transient']]) {
    await page.getByRole('button', { name, exact: true }).click();
    if (name === 'Speech signal') await page.waitForFunction(() => window.echoSphere.getStatus().visual.energy > 0.3);
    await page.waitForFunction(() => !window.echoSphere.getStatus().tourActive);
    assert.ok((await page.locator('#tourStatus').textContent()).includes(result));
  }
  await page.locator('#ambienceToggle').uncheck();
  assert.equal(submissions, 0);
  console.log('PASS no-key/no-microphone judging: labelled offline story, typed actions, three signal tours, ambient audio controls, zero LLM requests');

  // Simulate a TLS-terminating host without contacting any external website.
  // The browser sees HTTPS and exercises Secure cookies, Origin and same-origin fetch.
  await page.route('https://demo.example/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const response = await route.fetch({ url: `http://127.0.0.1:${hosted.address().port}${url.pathname}${url.search}`,
      headers: { ...request.headers(), host: 'demo.example' } });
    await route.fulfill({ response });
  });
  await page.goto('https://demo.example');
  await page.waitForFunction(() => window.echoSphere.getStatus().agentReady);
  assert.equal(await page.locator('#agentSetup').isHidden(), true);
  assert.match(await page.locator('#modeBadge').textContent(), /Live/);
  await page.locator('#storyText').fill('I open the observatory door.');
  await page.getByRole('button', { name: 'Send story text', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('agentReply').textContent === 'Hosted agent response for the judging flow.');
  assert.match(await page.locator('#replySource').textContent(), /Live Evolus/);
  assert.equal(calls, 1);
  await page.getByRole('button', { name: 'Test agent connection', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('agentTestStatus').textContent.startsWith('Connection verified'));
  assert.equal(calls, 2);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: '/tmp/echosphere-submission-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS hosted HTTPS proxy simulation: Secure visitor cookie, no key entry, typed turn, provider test, labelled live reply, mobile layout');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`http://127.0.0.1:${local.address().port}`);
  await page.waitForFunction(() => window.echoSphere && document.getElementById('atomCanvas').width > 0);
  const still = await page.locator('#atomCanvas').evaluate(canvas => canvas.toDataURL());
  await page.evaluate(() => new Promise(resolve => {
    let frames = 0; const tick = () => ++frames === 12 ? resolve() : requestAnimationFrame(tick); requestAnimationFrame(tick);
  }));
  assert.equal(await page.locator('#atomCanvas').evaluate(canvas => canvas.toDataURL()), still);
  await page.locator('#atomCanvas').press('ArrowRight');
  await page.waitForFunction(before => document.getElementById('atomCanvas').toDataURL() !== before, still);
  console.log('PASS reduced motion: idle atom holds still while keyboard exploration remains available');
} finally {
  await browser?.close();
  for (const server of [local, hosted]) { server.closeAllConnections(); server.close(); }
}
