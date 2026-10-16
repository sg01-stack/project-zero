import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import http from 'node:http';
import { once } from 'node:events';
import { WORKLET_SOURCE, TurnDispatcher, createLocalJsonHandler } from '../src/capture.mjs';

test('worklet captures contiguous 50 ms frames at 44.1/48 kHz without microphone playback', () => {
  for (const rate of [44100, 48000]) {
    let Processor;
    const packets = [];
    class Base { constructor() { this.port = { postMessage: p => packets.push(p) }; } }
    vm.runInNewContext(WORKLET_SOURCE, { sampleRate: rate, AudioWorkletProcessor: Base, registerProcessor: (_, p) => { Processor = p; } });
    const processor = new Processor();
    let position = 0;
    for (let k = 0; k < 40; k++) {
      const input = Float32Array.from({length: 128}, () => position++);
      const output = new Float32Array(128).fill(1);
      processor.process([[input]], [[output]]);
      assert.ok(output.every(x => x === 0));
    }
    assert.equal(packets.length, 2);
    assert.equal(packets[0].length, Math.round(rate * 0.05));
    assert.equal(packets[1][0], packets[0].length);
    processor.port.onmessage({ data: 'flush' });
    assert.equal(packets.length, 4);
    assert.equal(packets[3].flushed, true);
  }
});

test('unconnected turns queue; async delivery preserves order and immutable payloads', async () => {
  const statuses = [], received = [];
  const d = new TurnDispatcher(s => statuses.push(s));
  const p = { turn_id: 'a', transcript: { text: 'hi' } };
  d.enqueue(p); d.enqueue({ turn_id: 'b' }); p.transcript.text = 'mutated';
  assert.equal(statuses[0].state, 'not_connected'); assert.equal(d.queue.length, 2);
  await d.setHandler(async payload => { await new Promise(r => setTimeout(r, 1)); received.push(payload); });
  assert.deepEqual(received.map(p => p.turn_id), ['a', 'b']);
  assert.equal(received[0].transcript.text, 'hi'); assert.equal(d.queue.length, 0);
  assert.equal(statuses.at(-1).state, 'delivered');
});

test('failure retains the same turn ID and blocks later turns until retry', async () => {
  const d = new TurnDispatcher(); let fail = true; const received = [];
  d.enqueue({ turn_id: 'a' }); d.enqueue({ turn_id: 'b' });
  await d.setHandler(async p => { received.push(p.turn_id); p.turn_id = 'altered'; if (fail) throw new Error('offline'); });
  assert.equal(d.queue.length, 2); assert.equal(d.queue[0].turn_id, 'a');
  await d.drain(); assert.deepEqual(received, ['a']);
  fail = false; await d.retry(); assert.deepEqual(received, ['a', 'a', 'b']); assert.equal(d.queue.length, 0);
});

test('local HTTP adapter submits actual JSON; HTTP errors retain the turn', async t => {
  const received = []; let status = 503;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push({ contentType: req.headers['content-type'], method: req.method, body: JSON.parse(body) });
    res.writeHead(status); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const d = new TurnDispatcher();
  const payload = { schema_version: '1.0', event: 'user_turn_complete', turn_id: 's:1', transcript: null };
  d.enqueue(payload);
  await d.setHandler(createLocalJsonHandler({ url: `http://127.0.0.1:${server.address().port}/turn` }));
  assert.equal(d.failed, true); assert.equal(d.queue.length, 1);
  status = 204; await d.retry(); assert.equal(d.queue.length, 0);
  assert.equal(received[0].method, 'POST'); assert.equal(received[0].contentType, 'application/json');
  assert.deepEqual(received[1].body, payload);
});

test('local adapter rejects remote URLs and times out hung receivers', async t => {
  assert.throws(() => createLocalJsonHandler({ url: 'https://example.com/turn' }));
  const server = http.createServer(() => {});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const send = createLocalJsonHandler({ url: `http://127.0.0.1:${server.address().port}`, timeoutMs: 30 });
  await assert.rejects(send({ turn_id: 'timeout' }), { name: 'TimeoutError' });
});
