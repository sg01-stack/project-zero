export const WORKLET_SOURCE = `
class EchoSphereCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(Math.round(sampleRate * 0.05));
    this.position = 0;
    this.port.onmessage = ({data}) => {
      if (data === 'flush') {
        // Pad only the final partial frame; full frames always contain 50 ms.
        if (this.position) this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(Math.round(sampleRate * 0.05));
        this.position = 0;
        this.port.postMessage({ flushed: true });
      }
    };
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    if (input) for (let i = 0; i < input.length; i++) {
      this.buffer[this.position++] = input[i];
      if (this.position === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(Math.round(sampleRate * 0.05));
        this.position = 0;
      }
    }
    // Capture only. Do not send microphone audio to the speakers.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    return true;
  }
}
registerProcessor('echosphere-capture', EchoSphereCapture);
`;

// Explicit acknowledgement prevents displaying "sent" for a logged payload.
// Failed turns stay at the head of the queue; retries preserve the turn ID.
export class TurnDispatcher {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.queue = [];
    this.handler = null;
    this.running = false;
    this.failed = false;
  }
  enqueue(payload) {
    this.queue.push(JSON.parse(JSON.stringify(payload)));
    this.onStatus({ state: this.handler ? 'queued' : 'not_connected', pending: this.queue.length });
    void this.drain();
  }
  setHandler(handler) {
    if (handler !== null && typeof handler !== 'function') throw new TypeError('Handler must be a function or null.');
    this.handler = handler;
    this.failed = false;
    return this.drain();
  }
  retry() { this.failed = false; return this.drain(); }
  async drain() {
    if (this.running || this.failed || !this.handler) return;
    this.running = true;
    try {
      while (this.queue.length && this.handler) {
        const payload = this.queue[0];
        this.onStatus({ state: 'sending', turn_id: payload.turn_id, pending: this.queue.length });
        try {
          // Do not let a consumer mutate the copy retained for a possible retry.
          await this.handler(JSON.parse(JSON.stringify(payload)));
          this.queue.shift();
          this.onStatus({ state: 'delivered', turn_id: payload.turn_id, pending: this.queue.length });
        } catch (error) {
          this.failed = true;
          this.onStatus({ state: 'failed', turn_id: payload.turn_id, pending: this.queue.length,
            message: error instanceof Error ? error.message : String(error) });
          break;
        }
      }
    } finally { this.running = false; }
  }
}

export function createLocalJsonHandler({ url, timeoutMs = 20000 }) {
  const endpoint = new URL(url);
  if (!['http:', 'https:'].includes(endpoint.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password) {
    throw new Error('Use a loopback HTTP(S) endpoint for local JSON delivery.');
  }
  return async payload => {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Local endpoint returned HTTP ${response.status}`);
  };
}
