import { KokoroTTS } from '../vendor/kokoro.web.js';

let synthesizer;
let busy = false;
self.onmessage = async ({ data }) => {
  const { id, type } = data;
  if (busy) { self.postMessage({ id, type: 'error', message: 'The neural voice is busy.' }); return; }
  busy = true;
  try {
    if (type === 'load') {
      synthesizer ||= await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
        dtype: 'q8', device: 'wasm',
        progress_callback: event => {
          const message = event.status === 'progress' ? `Downloading ${event.file}: ${Math.round(event.progress || 0)}%`
            : event.status === 'ready' ? 'Neural voice model ready.' : 'Loading the local voice model. The first download can take a few minutes.';
          self.postMessage({ type: 'progress', message });
        },
      });
      self.postMessage({ id, type: 'loaded' });
    } else if (type === 'generate') {
      if (!synthesizer) throw new Error('Load the neural voice model first.');
      if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 450) throw new Error('Speech segments must contain 1–450 characters.');
      const audio = await synthesizer.generate(data.text, { voice: data.voice, speed: Math.min(1.25, Math.max(0.75, Number(data.speed) || 1)) });
      const pcm = new Float32Array(audio.audio);
      self.postMessage({ id, type: 'audio', pcm, sampleRate: audio.sampling_rate }, [pcm.buffer]);
    } else throw new Error('Unknown voice operation.');
  } catch (error) {
    self.postMessage({ id, type: 'error', message: `Neural voice unavailable: ${error.message}. Check access to Hugging Face and jsDelivr, or choose a system voice.` });
  } finally { busy = false; }
};
