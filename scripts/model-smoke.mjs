// Optional real model check. Downloads public model assets; uses no Evolus key.
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
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async () => {
    const { NeuralVoice } = await import('/src/voice.mjs');
    const { SpeechRecognizer, speechSamples } = await import('/src/conversation.mjs');
    const voice = new NeuralVoice(), recognizer = new SpeechRecognizer();
    try {
      await Promise.all([voice.load(), recognizer.load()]);
      const audio = await voice.generate('The observatory door is open. Please come inside.', 'af_heart', 0.95);
      if (!(audio.pcm instanceof Float32Array) || audio.pcm.length < 24000) throw new Error('No usable neural speech PCM returned.');
      const transcription = await recognizer.transcribe(speechSamples(audio.pcm, audio.sampleRate));
      return { seconds: audio.pcm.length / audio.sampleRate, transcript: transcription.text };
    } finally { voice.cancel(); recognizer.cancel(); }
  });
  assert.match(result.transcript.toLowerCase(), /door/);
  assert.match(result.transcript.toLowerCase(), /open/);
  console.log('PASS real Kokoro generation → Whisper recognition:', JSON.stringify(result));
} finally { await browser?.close(); server.closeAllConnections(); server.close(); }
