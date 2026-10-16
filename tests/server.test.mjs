import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createEvolusClient, listEvolusModels, resolveAgentModel, DEFAULT_AGENT_ID } from '../server/evolus.mjs';
import { createApplicationServer } from '../server/app.mjs';

const fixture = () => ({ schema_version: '1.0', event: 'user_turn_complete', session_id: 'test-session', turn_id: 'test-session:1',
  transcript: null, prosody_analysis: { dominant_style: 'whisper_like', average_rms_dbfs: -30 },
  quality: { possible_non_speech: true, emotion_inferred: false } });
const ROUTE = `11111111-1111-4111-8111-111111111111:${DEFAULT_AGENT_ID}`;
const testEnv = { EVOLUS_API_KEY: 'test-only-placeholder', EVOLUS_MODEL: 'own/gemma-4-31b-it' };
const root = fileURLToPath(new URL('..', import.meta.url));
async function serve(t, options = {}) {
  const server = createApplicationServer({ root, env: {}, listModels: async () => [ROUTE], ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (payload, options = {}) => fetch(`${base}/api/turn`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), ...options });
  return { base, post };
}

test('Evolus adapter sends OpenAI-style messages with JSON data and a server-only key', async () => {
  const calls = [];
  const call = createEvolusClient({ apiKey: testEnv.EVOLUS_API_KEY, model: testEnv.EVOLUS_MODEL, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'The corridor falls quiet.' }, finish_reason: 'stop' }] }));
  } });
  const payload = fixture();
  const result = await call(payload);
  assert.equal(calls[0].url, 'https://api.evolus.ai/v1/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-only-placeholder');
  const request = JSON.parse(calls[0].options.body);
  assert.equal(request.model, 'own/gemma-4-31b-it'); assert.equal(request.stream, false);
  assert.equal(request.messages[0].role, 'system');
  assert.deepEqual(JSON.parse(request.messages[1].content), payload);
  assert.deepEqual(result, { turn_id: payload.turn_id, reply: 'The corridor falls quiet.', finish_reason: 'stop' });
  assert.ok(!JSON.stringify(result).includes(testEnv.EVOLUS_API_KEY));
});

test('Evolus errors and invalid response bodies are errors, never successful delivery', async () => {
  for (const fetchImpl of [
    async () => new Response('private upstream details', { status: 401 }),
    async () => new Response('not JSON'),
    async () => new Response('{}'),
    async () => { throw new Error('private connection details'); },
  ]) {
    const call = createEvolusClient({ apiKey: testEnv.EVOLUS_API_KEY, model: testEnv.EVOLUS_MODEL, fetchImpl });
    await assert.rejects(call(fixture()), error => error.statusCode === 502 && !error.message.includes('private'));
  }
  await assert.rejects(createEvolusClient({})(fixture()), error => error.statusCode === 503);
});

test('backend status lists missing names; source/assets cannot disclose server files or keys', async t => {
  const { base, post } = await serve(t, { env: {} });
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.deepEqual(status.missing, ['EVOLUS_API_KEY']);
  assert.equal(status.configured, false); assert.equal(status.live_connection_verified, false);
  assert.equal((await post(fixture())).status, 503);
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/src/audio-engine.mjs`)).status, 200);
  for (const path of ['/server/evolus.mjs', '/.env', '/package.json', '/tests/server.test.mjs', '/.git/config']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
});

test('actual HTTP turn submission reaches adapter and deduplicates retries and concurrent submissions', async t => {
  let calls = 0;
  const completeTurn = async payload => {
    calls++; await new Promise(resolve => setTimeout(resolve, 10));
    return { turn_id: payload.turn_id, reply: 'Mock agent reply.' };
  };
  const { post } = await serve(t, { env: testEnv, completeTurn });
  const responses = await Promise.all([post(fixture()), post(fixture())]);
  for (const response of responses) { assert.equal(response.status, 200); assert.equal((await response.json()).reply, 'Mock agent reply.'); }
  assert.equal(calls, 1);
  assert.equal((await post(fixture())).status, 200); assert.equal(calls, 1);
  const changed = fixture(); changed.transcript = { text: 'different content' };
  assert.equal((await post(changed)).status, 409);
});

test('backend rejects malformed, excessive and cross-origin submissions without invoking model', async t => {
  let calls = 0;
  const { post } = await serve(t, { env: testEnv, completeTurn: async () => { calls++; return {}; } });
  assert.equal((await post({ event: 'audio_event' })).status, 400);
  assert.equal((await post(fixture(), { body: '{broken' })).status, 400);
  assert.equal((await post(fixture(), { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await post(fixture(), { headers: { 'Content-Type': 'application/json', Origin: 'https://other-site.example' } })).status, 403);
  assert.equal((await post(fixture(), { body: JSON.stringify({ padding: 'x'.repeat(65537) }) })).status, 413);
  assert.equal(calls, 0);
});

test('a failed agent call is retryable and its body is not cached', async t => {
  let calls = 0;
  const { post } = await serve(t, { env: testEnv, completeTurn: async payload => {
    if (++calls === 1) throw Object.assign(new Error('Evolus returned HTTP 503.'), { statusCode: 502 });
    return { turn_id: payload.turn_id, reply: 'Recovered.' };
  } });
  assert.equal((await post(fixture())).status, 502);
  assert.equal((await post(fixture())).status, 200);
  assert.equal(calls, 2);
});

test('model discovery sends only a server-side key and returns unique model IDs', async () => {
  const ids = await listEvolusModels({ apiKey: 'test-only-placeholder', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.evolus.ai/v1/models');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer test-only-placeholder');
    return new Response(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-a' }, { id: '' }, { id: null }, { id: 'bad\nname' }] }));
  } });
  assert.deepEqual(ids, ['model-a', 'model-b']);
});

test('model discovery distinguishes missing key, denied access, unsupported route and unexpected format', async () => {
  let requests = 0;
  await assert.rejects(listEvolusModels({ fetchImpl: async () => { requests++; } }), error => error.statusCode === 503);
  assert.equal(requests, 0);
  for (const [status, body, message] of [
    [401, 'private details', /rejected model-list access/],
    [404, 'private details', /does not expose/],
    [200, '{}', /unexpected model-list format/],
    [200, 'invalid', /unreadable model list/],
  ]) {
    await assert.rejects(listEvolusModels({ apiKey: 'test-only-placeholder', fetchImpl: async () => new Response(body, { status }) }), error => message.test(error.message) && !error.message.includes('private'));
  }
});

test('agent discovery resolves the configured agent despite the old Gemma model label', async t => {
  const chosen = [];
  let discoveryCalls = 0;
  const { base, post } = await serve(t, { env: testEnv,
    listModels: async () => { discoveryCalls++; return [ROUTE]; },
    completeTurn: async (p, model) => { chosen.push(model); return { turn_id: p.turn_id, reply: 'Test reply.' }; },
  });
  const statuses = await Promise.all([fetch(`${base}/api/status`), fetch(`${base}/api/status`)]);
  for (const response of statuses) {
    const status = await response.json();
    assert.equal(status.configured, true); assert.equal(status.selected_model, ROUTE);
    assert.equal(status.integration_mode, 'agent'); assert.equal(status.agent_route_verified, true);
    assert.equal(status.live_connection_verified, false);
  }
  assert.equal(discoveryCalls, 1);
  assert.equal((await post(fixture())).status, 200); assert.deepEqual(chosen, [ROUTE]);
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.live_connection_verified, true);
});

test('agent discovery never picks an unrelated or ambiguous route', () => {
  const otherAgent = '22222222-2222-4222-8222-222222222222';
  const otherRoute = `33333333-3333-4333-8333-333333333333:${DEFAULT_AGENT_ID}`;
  assert.equal(resolveAgentModel([ROUTE], { preferredModel: 'own/gemma-4-31b-it' }), ROUTE);
  assert.throws(() => resolveAgentModel([`11111111-1111-4111-8111-111111111111:${otherAgent}`]), /does not list/);
  assert.throws(() => resolveAgentModel([ROUTE, otherRoute]), /Several applications/);
  assert.equal(resolveAgentModel([ROUTE, otherRoute], { preferredModel: otherRoute }), otherRoute);
  assert.throws(() => resolveAgentModel(['own/gemma-4-31b-it']), /does not list/);
});

test('missing credentials stop discovery locally; discovery errors can be retried', async t => {
  let discoveryCalls = 0;
  const missing = await serve(t, { env: {}, listModels: async () => { discoveryCalls++; return []; } });
  assert.equal((await (await fetch(`${missing.base}/api/status`)).json()).configured, false);
  assert.equal(discoveryCalls, 0);
  let fail = true;
  const h = await serve(t, { env: testEnv, listModels: async () => {
    if (fail) throw Object.assign(new Error('Service unavailable'), {statusCode: 502});
    return [ROUTE];
  } });
  const status = await (await fetch(`${h.base}/api/status`)).json();
  assert.equal(status.configured, false); assert.equal(status.error, 'Service unavailable');
  fail = false;
  assert.equal((await (await fetch(`${h.base}/api/status`)).json()).configured, true);
});

test('story context stays within its session and failed or duplicate turns do not append it', async t => {
  const calls = [];
  let fail = false;
  const { post } = await serve(t, { env: testEnv, completeTurn: async (p, model, history) => {
    calls.push({id: p.turn_id, history});
    if (fail) throw Object.assign(new Error('Temporary failure'), {statusCode: 502});
    return {turn_id: p.turn_id, reply: `Reply for ${p.turn_id}`};
  } });
  const first = fixture(); await post(first); await post(first);
  const second = {...fixture(), turn_id: 'test-session:2'};
  fail = true; assert.equal((await post(second)).status, 502);
  fail = false; assert.equal((await post(second)).status, 200);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].history, []);
  assert.deepEqual(calls[1].history, calls[2].history);
  assert.equal(calls[2].history.length, 2);
  assert.equal(calls[2].history[1].content, 'Reply for test-session:1');
  await post({...fixture(), session_id: 'another-session', turn_id: 'another-session:1'});
  assert.deepEqual(calls.at(-1).history, []);
});

test('a different simultaneous turn in the same session is rejected without losing order', async t => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const { post } = await serve(t, {env: testEnv, completeTurn: async p => {
    entered(); await new Promise(resolve => { release = resolve; });
    return {turn_id: p.turn_id, reply: 'Done'};
  }});
  const pending = post(fixture()); await ready;
  assert.equal((await post({...fixture(), turn_id:'test-session:2'})).status, 409);
  release(); assert.equal((await pending).status, 200);
});
