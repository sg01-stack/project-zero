import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createApplicationServer } from '../server/app.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const server = createApplicationServer({ root: fileURLToPath(new URL('..', import.meta.url)), env: {} });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const measured = await page.evaluate(async () => {
    const { createVoiceGraph, voicePosition } = await import('/src/voice.mjs');
    const render = async (angle, distance, room) => {
      const context = new OfflineAudioContext(2, 48000 * 3, 48000);
      const graph = createVoiceGraph(context); graph.update(voicePosition({ angle, distance, room }));
      const oscillator = context.createOscillator(); oscillator.type = 'sawtooth'; oscillator.frequency.value = 220;
      const gain = context.createGain(); gain.gain.value = 0.08;
      oscillator.connect(gain); gain.connect(graph.input); oscillator.start(0.2); oscillator.stop(1.4);
      const audio = await context.startRendering();
      const power = (channel, start, end) => audio.getChannelData(channel).slice(start * 48000, end * 48000).reduce((sum, sample) => sum + sample * sample, 0);
      return { left: power(0, 0.5, 1.3), right: power(1, 0.5, 1.3), tail: power(0, 1.6, 2.7) + power(1, 1.6, 2.7), model: graph.panner.panningModel };
    };
    return { left: await render(-80, 1, 0), right: await render(80, 1, 0), far: await render(-80, 8, 0), room: await render(-80, 1, 0.6) };
  });
  assert.equal(measured.left.model, 'HRTF');
  assert.ok(measured.left.left > measured.left.right * 1.4, 'Left placement must change actual rendered audio');
  assert.ok(measured.right.right > measured.right.left * 1.4, 'Right placement must change actual rendered audio');
  assert.ok(measured.far.left + measured.far.right < (measured.left.left + measured.left.right) * 0.3, 'Distance must attenuate actual audio');
  assert.ok(measured.room.tail > 0.00001 && measured.room.tail > measured.left.tail * 10, 'Room setting must produce a measurable decay tail');
  console.log('PASS rendered stereo PCM: HRTF left/right separation, distance attenuation, and room decay');

  // Exercise the real bundled worker with unavailable model hosting. This
  // checks failure recovery, not successful neural inference.
  await page.context().route('https://**', route => route.abort());
  await page.locator('#loadVoiceBtn').click();
  await page.waitForFunction(() => document.getElementById('voiceStatus').textContent.includes('Neural voice unavailable'), {}, { timeout: 30000 });
  assert.equal(await page.locator('#loadVoiceBtn').isEnabled(), true);
  assert.equal(await page.evaluate(() => window.echoSphere.getStatus().voice.neuralReady), false);
  console.log('PASS real neural worker import and clear recovery when model downloads are unavailable');
  const recognitionFailure = await page.evaluate(async () => {
    const { SpeechRecognizer } = await import('/src/conversation.mjs');
    const recognizer = new SpeechRecognizer();
    try { await recognizer.load(); return 'unexpected success'; }
    catch (error) { return error.message; }
    finally { recognizer.cancel(); }
  });
  assert.match(recognitionFailure, /Local speech recognition failed/);
  console.log('PASS real recognition worker import and clear failure when model hosting is unavailable');

  // Replace only inference: exercise real UI, segmentation, transferred PCM,
  // Web Audio playback and stop. This is not a real model-quality test.
  await page.addInitScript(() => {
    window.voiceRequests = [];
    window.Worker = class {
      postMessage(data) {
        window.voiceRequests.push(data);
        if (window.hangVoice) return;
        setTimeout(() => this.onmessage?.({ data: data.type === 'load' ? { id: data.id, type: 'loaded' }
          : { id: data.id, type: 'audio', pcm: Float32Array.from({ length: 6000 }, (_, i) => Math.sin(i * 0.08) * 0.1), sampleRate: 24000 } }), 20);
      }
      terminate() { window.workerTerminated = true; }
    };
  });
  await page.reload();
  await page.locator('#voiceSelect').selectOption('bf_emma');
  await page.locator('#voicePreset').selectOption('passing');
  await page.locator('#previewVoiceBtn').click();
  await page.waitForFunction(() => document.getElementById('playbackStatus').textContent.startsWith('Playback finished'), {}, { timeout: 15000 });
  const requests = await page.evaluate(() => window.voiceRequests);
  assert.equal(requests[0].type, 'load');
  assert.ok(requests.filter(request => request.type === 'generate').every(request => request.voice === 'bf_emma'));
  assert.ok(requests.filter(request => request.type === 'generate').length >= 3);
  assert.equal(await page.evaluate(() => window.echoSphere.getStatus().voice.neuralReady), true);
  await page.evaluate(() => { window.hangVoice = true; });
  await page.locator('#previewVoiceBtn').click();
  await page.waitForFunction(() => window.echoSphere.getStatus().voice.busy);
  await page.locator('#stopVoiceBtn').click();
  assert.equal(await page.evaluate(() => window.echoSphere.getStatus().voice.busy), false);
  assert.equal(await page.evaluate(() => window.workerTerminated), true);
  assert.equal(await page.evaluate(() => window.echoSphere.getStatus().voice.neuralReady), false);
  assert.deepEqual(errors, []);
  console.log('PASS voice selection, segmented neural-to-spatial playback, and cancellation (inference mocked)');
} finally { await browser?.close(); server.closeAllConnections(); server.close(); }
