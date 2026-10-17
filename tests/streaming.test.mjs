import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createEvolusClient, DEFAULT_AGENT_ID } from '../server/evolus.mjs';
import { createApplicationServer } from '../server/app.mjs';

const payload = { schema_version: '1.0', event: 'story_start', session_id: 'stream-session', turn_id: 'opening', transcript: null, prosody_analysis: null };
const route = `11111111-1111-4111-8111-111111111111:${DEFAULT_AGENT_ID}`;

test('Evolus SSE emits text before completion, handles split UTF-8 and rejects truncated replies', async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const encoder = new TextEncoder();
  const body = new ReadableStream({ async start(controller) {
    const first = encoder.encode('data: {"choices":[{"delta":{"content":"The guide says “hello”. "}}]}\r\n\r\n');
    for (let i = 0; i < first.length; i += 7) controller.enqueue(first.slice(i, i + 7));
    await barrier;
    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Come inside."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    controller.close();
  } });
  let request, chunks = [];
  const client = createEvolusClient({ apiKey: 'test-secret', model: route, fetchImpl: async (url, options) => {
    request = JSON.parse(options.body); return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  const result = await client(payload, [], { onText: text => { chunks.push(text); release(); } });
  assert.equal(request.stream, true); assert.equal(request.max_tokens, 180);
  assert.equal(chunks[0], 'The guide says “hello”. ');
  assert.equal(result.reply, chunks.join('')); assert.equal(result.finish_reason, 'stop');
  const broken = createEvolusClient({ apiKey: 'test-secret', model: route, fetchImpl: async () => new Response('data: {"choices":[{"delta":{"content":"unfinished"}}]}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }) });
  await assert.rejects(broken(payload, [], { onText() {} }), /interrupted or invalid/);
});

async function serverFor(t, completeTurn) {
  const server = createApplicationServer({ root: fileURLToPath(new URL('..', import.meta.url)), env: { EVOLUS_API_KEY: 'server-only-placeholder' }, listModels: async () => [route], completeTurn });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return (body, signal, accept = 'application/x-ndjson') => fetch(`http://127.0.0.1:${server.address().port}/api/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: accept }, body: JSON.stringify(body), signal,
  });
}

test('HTTP streaming sends the opening early, deduplicates retries and retains story history', async t => {
  let release, calls = 0;
  const barrier = new Promise(resolve => { release = resolve; });
  const histories = [];
  const post = await serverFor(t, async (p, model, history, { onText }) => {
    calls++; histories.push(history); onText?.('Welcome to the observatory. ');
    await barrier;
    return { turn_id: p.turn_id, reply: 'Welcome to the observatory. Come inside.' };
  });
  const response = await post(payload);
  assert.equal(response.headers.get('content-type'), 'application/x-ndjson');
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /"type":"delta"/); assert.doesNotMatch(first, /"complete"|server-only-placeholder/);
  release();
  let rest = '';
  while (true) { const { value, done } = await reader.read(); if (done) break; rest += new TextDecoder().decode(value); }
  assert.match(rest, /"type":"complete"/);
  assert.equal((await (await post(payload)).json()).reply, 'Welcome to the observatory. Come inside.');
  assert.equal(calls, 1);
  await (await post({ ...payload, event: 'story_continue', turn_id: 'continue' }, undefined, 'application/json')).json();
  assert.equal(histories[1].length, 2);
  assert.equal(JSON.parse(histories[1][0].content).event, 'story_start');
  assert.equal((await post({ ...payload, turn_id: 'invalid', transcript: { text: 'invented speech' } })).status, 400);
});

test('disconnect aborts upstream work and preserves user words without caching unheard narration', { timeout: 5000 }, async t => {
  let aborted, calls = 0, receivedHistory;
  const didAbort = new Promise(resolve => { aborted = resolve; });
  const post = await serverFor(t, async (p, model, history, { onText, signal }) => {
    calls++;
    if (calls === 1) {
      onText('An unfinished reply. ');
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted(); reject(new Error('cancelled')); }, { once: true }));
    }
    receivedHistory = history;
    return { turn_id: p.turn_id, reply: 'Listening to your new direction.' };
  });
  const controller = new AbortController();
  const input = { ...payload, event: 'user_text', transcript: { text: 'I go left.', source: 'typed' } };
  const response = await post(input, controller.signal);
  const reader = response.body.getReader(); await reader.read(); controller.abort();
  await didAbort; await reader.cancel().catch(() => {});
  const next = await post({ ...input, turn_id: 'next', transcript: { text: 'Actually, wait.' } }, undefined, 'application/json');
  assert.equal(next.status, 200); await next.json();
  assert.equal(receivedHistory.length, 1); assert.equal(receivedHistory[0].role, 'user');
  assert.equal(JSON.parse(receivedHistory[0].content).transcript.text, 'I go left.');
});
