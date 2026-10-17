import { pipeline, env } from '../vendor/transformers.web.js';

env.allowLocalModels = false;
let recognizer, modelName, busy = false;
self.onmessage = async ({ data }) => {
  const { id, type } = data;
  if (busy) { self.postMessage({ id, type: 'error', message: 'Speech recognition is busy.' }); return; }
  busy = true;
  try {
    if (type === 'load') {
      const model = data.model === 'tiny' ? 'tiny' : 'base';
      if (recognizer && modelName !== model) { await recognizer.dispose(); recognizer = null; }
      recognizer ||= await pipeline('automatic-speech-recognition', `Xenova/whisper-${model}.en`, {
        dtype: 'q8', device: 'wasm', progress_callback: event => {
          self.postMessage({ type: 'progress', message: event.status === 'progress'
            ? `Speech recognition download: ${event.file} ${Math.round(event.progress || 0)}%`
            : 'Preparing local speech recognition…' });
        },
      });
      modelName = model;
      self.postMessage({ id, type: 'loaded' });
    } else if (type === 'transcribe') {
      if (!recognizer) throw new Error('Speech recognition is not ready yet.');
      if (!(data.pcm instanceof Float32Array) || data.pcm.length < 1600 || data.pcm.length > 16000 * 32) throw new Error('Invalid speech segment.');
      const result = await recognizer(data.pcm, { chunk_length_s: 30, stride_length_s: 3, return_timestamps: false, do_sample: false });
      self.postMessage({ id, type: 'transcript', text: result.text.trim(), source: `local_whisper_${modelName}_en` });
    } else throw new Error('Unknown recognition operation.');
  } catch (error) { self.postMessage({ id, type: 'error', message: `Local speech recognition failed: ${error.message}` }); }
  finally { busy = false; }
};
