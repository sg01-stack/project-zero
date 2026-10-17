import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApplicationServer } from '../server/app.mjs';
import { DEFAULT_AGENT_ID } from '../server/evolus.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const directory = await mkdtemp(join(tmpdir(), 'echosphere-conversation-'));
const rate = 48000, seconds = 18, wav = Buffer.alloc(44 + rate * seconds * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24);
wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < rate * seconds; i++) {
  // A 400 ms in-utterance pause starts a speculative recognition, then speech
  // resumes. Its incomplete text must never be sent as the final user turn.
  const t = i / rate, active = (t >= 3 && t < 3.5) || (t >= 3.9 && t < 4.5) || (t >= 7 && t < 8.5);
  wav.writeInt16LE(Math.round((active ? 0.15 * Math.sin(2 * Math.PI * 160 * t) : 0) * 32767), 44 + i * 2);
}
const fixture = join(directory, 'conversation.wav'); await writeFile(fixture, wav);
const received = [];
const server = createApplicationServer({ root: fileURLToPath(new URL('..', import.meta.url)),
  env: { EVOLUS_API_KEY: 'test-only-placeholder' },
  listModels: async () => [`11111111-1111-4111-8111-111111111111:${DEFAULT_AGENT_ID}`],
  completeTurn: async (payload, model, history, { onText }) => {
    received.push(payload);
    const reply = payload.event === 'story_start' ? 'The guide whispers beside you.' : 'A distant voice echoes across the great hall.';
    onText?.(reply + ' ');
    return { turn_id: payload.turn_id, reply };
  },
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fixture}`] });
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.recognizedSegments = []; window.generatedSpeech = []; window.modelLoads = 0; window.finalSegments = 0;
    window.Worker = class {
      constructor(url) { this.asr = String(url).includes('asr-worker'); }
      postMessage(data) {
        let response;
        if (data.type === 'load') { window.modelLoads++; if (window.hangLoads) return; response = { id: data.id, type: 'loaded' }; }
        else if (this.asr) {
          window.recognizedSegments.push(data.pcm.length);
          const text = data.pcm.length < 20000 ? 'unfinished fragment' : ++window.finalSegments === 1 ? 'I take the left passage.' : 'Wait, I want to listen.';
          response = { id: data.id, type: 'transcript', text };
        } else {
          window.generatedSpeech.push(data.text);
          response = { id: data.id, type: 'audio', sampleRate: 24000,
            pcm: Float32Array.from({ length: 24000 * 6 }, (_, i) => Math.sin(i * 0.07) * 0.08) };
        }
        setTimeout(() => this.onmessage?.({ data: response }), 30);
      }
      terminate() {}
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.echoSphere?.getStatus().agentReady);
  await page.locator('#initializeBtn').click();
  await page.waitForFunction(() => window.echoSphere.getStatus().conversation.active);
  await page.waitForFunction(() => window.generatedSpeech.length >= 1, {}, { timeout: 18000 });
  assert.equal(received[0].event, 'story_start');
  assert.equal(received[0].transcript, null);
  await page.waitForFunction(() => document.getElementById('voicePreset').value === 'intimate');
  await page.waitForFunction(() => window.generatedSpeech.length >= 2, {}, { timeout: 18000 });
  assert.equal(received[1].transcript.text, 'I take the left passage.', JSON.stringify({ received, segments: await page.evaluate(() => window.recognizedSegments) }));
  assert.equal(received[1].transcript.source, 'local_whisper_base_en');
  assert.equal(received[1].speech_evidence.words_available, true);
  assert.equal(received[1].prosody_analysis.dominant_style, 'voiced_speech');
  assert.equal(Object.hasOwn(received[1], 'pcm'), false);
  assert.equal(received[0].session_id, received[1].session_id);
  await page.waitForFunction(() => document.getElementById('voicePreset').value === 'hall');
  assert.equal(await page.evaluate(() => window.echoSphere.getStatus().running), true);
  await page.waitForFunction(() => window.echoSphere.getStatus().conversation.interruptions >= 1, {}, { timeout: 15000 });
  assert.equal(await page.evaluate(() => window.echoSphere.getStatus().running), true);
  await page.waitForFunction(() => window.generatedSpeech.length >= 3, {}, { timeout: 15000 });
  assert.equal(received[2].transcript.text, 'Wait, I want to listen.');
  const segments = await page.evaluate(() => window.recognizedSegments);
  assert.ok(segments.some(length => length < 20000), 'Exercise speculative recognition before speech resumes');
  assert.ok(segments.every(length => length > 1600 && length < 16000 * 3));
  assert.ok(received.every(payload => payload.transcript?.text !== 'unfinished fragment'), 'Do not submit speculative fragments');
  await page.locator('#initializeBtn').click();
  await page.waitForFunction(() => !window.echoSphere.getStatus().running);
  await page.reload();
  await page.waitForFunction(() => window.echoSphere?.getStatus().agentReady);
  await page.evaluate(() => { window.hangLoads = true; });
  await page.locator('#initializeBtn').click();
  await page.waitForFunction(() => window.modelLoads >= 2);
  await page.locator('#initializeBtn').click();
  await page.waitForFunction(() => !window.echoSphere.getStatus().running && !window.echoSphere.getStatus().conversation.preparing);
  assert.equal(await page.evaluate(() => window.echoSphere.getStatus().conversation.active), false);
  assert.match(await page.locator('#conversationStatus').textContent(), /paused/);
  assert.deepEqual(errors, []);
  console.log('PASS proactive opening → fake microphone → early local recognition → transcript + prosody → streamed backend → automatic scene placement and speech; interruption and warmup cancellation (models/provider mocked)');
} finally { await browser?.close(); server.closeAllConnections(); server.close(); await rm(directory, { recursive: true, force: true }); }
