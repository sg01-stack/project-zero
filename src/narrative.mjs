import { VOICE_PRESETS } from './voice.mjs';

// Deliberately bounded scene direction, derived from narrated context rather
// than another remote request. These cues describe a room/voice, not emotion.
export function storyPlacement(text, previous = 'guide') {
  const words = String(text).toLowerCase();
  let preset = previous;
  if (/\b(distant|far away|across the|from the far)\b/.test(words)) preset = 'hall';
  else if (/\b(whisper\w*|hush\w*|beside (?:you|me)|(?:at|by) (?:your|my) side|close to (?:you|me)|in your ear|softly|barely a breath|lowers? (?:my|her|his|their|the) voice)\b/.test(words)) preset = 'intimate';
  else if (/\b(circl\w*|around you|surround\w*|orbit\w*)\b/.test(words)) preset = 'orbit';
  else if (/\b(pass\w* (?:you|by|from)|cross\w*|walk\w* past)\b/.test(words)) preset = 'passing';
  else if (/\b(guide|beside|nearby|approach\w*)\b/.test(words)) preset = 'guide';
  const options = { ...(VOICE_PRESETS[preset] || VOICE_PRESETS.guide) };
  // A noise echoing in the room does not mean the narrator walked away.
  // Keep their established distance; change only the room contribution.
  if (preset !== 'intimate' && /\b(vast|echo\w*|cavern\w*|great hall)\b/.test(words)) options.room = Math.max(options.room, 0.4);
  if (/\b(?:to|on|from|at) (?:your |the )?(?:far )?left\b/.test(words)) { options.angle = -55; options.motion = 'still'; }
  if (/\b(?:to|on|from|at) (?:your |the )?(?:far )?right\b/.test(words)) { options.angle = 55; options.motion = 'still'; }
  if (/\bbehind you\b/.test(words)) { options.angle = 155; options.motion = 'still'; }
  return { preset, options };
}

// Holds incomplete sentences until the stream supplies a boundary. Flush the
// final fragment explicitly; never lose the last word or speak JSON/metadata.
export class NarrationBuffer {
  constructor() { this.text = ''; }
  push(delta, final = false) {
    this.text += delta;
    const segments = [];
    let match;
    while ((match = this.text.match(/^([\s\S]*?[.!?]["”’']?)(?:\s+|$)/))) {
      if (!final && match[0].length === this.text.length && !/\s$/.test(this.text)) break;
      segments.push(match[1].trim()); this.text = this.text.slice(match[0].length);
    }
    if (final && this.text.trim()) { segments.push(this.text.trim()); this.text = ''; }
    return segments.filter(Boolean);
  }
}

export async function readNarrationResponse(response, onDelta) {
  if (!response.ok) {
    const body = await response.json();
    throw new Error(body.error || `Backend returned HTTP ${response.status}`);
  }
  if (!response.headers.get('content-type')?.includes('application/x-ndjson')) return response.json();
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', result;
  const line = value => {
    if (!value.trim()) return;
    const event = JSON.parse(value);
    if (event.type === 'error') throw new Error(event.error || 'Narration stream failed.');
    if (event.type === 'delta' && typeof event.text === 'string') onDelta(event.text);
    if (event.type === 'complete') result = event.result;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1); }
      if (done) break;
    }
    line(buffer);
    if (!result) throw new Error('Narration ended before the reply was complete. Retry delivery.');
    return result;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
