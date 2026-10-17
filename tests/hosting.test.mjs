import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createApplicationServer } from '../server/app.mjs';
import { hostingOptions } from '../server/hosting.mjs';
import { DEFAULT_AGENT_ID } from '../server/evolus.mjs';

const origin = 'https://demo.example';
const route = `11111111-1111-4111-8111-111111111111:${DEFAULT_AGENT_ID}`;
const payload = id => ({ schema_version: '1.0', event: 'user_text', session_id: 'same-session', turn_id: id,
  transcript: { text: 'I take the left passage.', source: 'typed' }, prosody_analysis: null });

test('hosted HTTPS proxy flow keeps credentials private, isolates visitors and bounds paid calls', async t => {
  const calls = [];
  const server = createApplicationServer({ root: fileURLToPath(new URL('..', import.meta.url)),
    env: { ECHOSPHERE_HOSTED: 'true', PUBLIC_ORIGIN: origin, EVOLUS_API_KEY: 'test-only-placeholder', MAX_AGENT_CALLS_PER_HOUR: '3' },
    listModels: async () => [route],
    completeTurn: async (p, model, history) => { calls.push({ p, history }); return { turn_id: p.turn_id, reply: `Reply ${calls.length}` }; },
    persistSettings: async () => assert.fail('Visitors must never change hosted credentials'),
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = (path, { body, cookie, token, headers } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method: body ? 'POST' : 'GET',
      headers: { Host: 'demo.example', Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}), ...(token ? { 'X-EchoSphere-Token': token } : {}), ...headers } }, res => {
      let data = ''; res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  assert.equal((await request('/api/health', { headers: { Host: 'internal-host' } })).status, 200);
  assert.equal((await request('/api/status', { headers: { Host: 'attacker.example' } })).status, 403);
  assert.equal((await request('/api/status', { headers: { Origin: 'https://attacker.example' } })).status, 403);
  const a = await request('/api/status'), b = await request('/api/status');
  assert.equal(a.body.setup_allowed, false); assert.equal(a.body.configured, true);
  assert.ok(!JSON.stringify(a).includes('test-only-placeholder'));
  assert.match(a.headers['set-cookie'][0], /HttpOnly; Secure; SameSite=Strict/);
  const cookieA = a.headers['set-cookie'][0].split(';')[0], cookieB = b.headers['set-cookie'][0].split(';')[0];
  assert.notEqual(cookieA, cookieB);
  assert.equal((await request('/api/config', { body: {}, cookie: cookieA, token: a.body.setup_token })).status, 403);
  assert.equal((await request('/api/turn', { body: payload('1') })).status, 401);
  assert.equal((await request('/api/turn', { body: payload('1'), cookie: cookieA })).body.reply, 'Reply 1');
  assert.equal((await request('/api/turn', { body: payload('1'), cookie: cookieB })).body.reply, 'Reply 2');
  assert.deepEqual(calls[0].history, []); assert.deepEqual(calls[1].history, []);
  assert.equal((await request('/api/turn', { body: payload('2'), cookie: cookieA })).status, 200);
  assert.equal(calls[2].history[1].content, 'Reply 1');
  assert.equal((await request('/api/turn', { body: payload('2'), cookie: cookieA })).status, 200);
  assert.equal(calls.length, 3, 'Cached retry must not use the shared budget');
  assert.equal((await request('/api/turn', { body: payload('2'), cookie: cookieB })).status, 429);
  assert.equal((await request('/api/check', { body: {}, cookie: cookieA, token: a.body.setup_token })).status, 429);
  assert.equal(calls.length, 3);
});

test('hosted mode requires an explicit HTTPS origin and valid usage limit', () => {
  assert.deepEqual(hostingOptions({}), { hosted: false });
  for (const PUBLIC_ORIGIN of ['http://demo.example', 'https://demo.example/path', 'https://user:pass@demo.example', '']) {
    assert.throws(() => hostingOptions({ ECHOSPHERE_HOSTED: 'true', PUBLIC_ORIGIN }));
  }
  assert.throws(() => hostingOptions({ ECHOSPHERE_HOSTED: 'true', PUBLIC_ORIGIN: origin, MAX_AGENT_CALLS_PER_HOUR: 'bad' }));
  assert.equal(hostingOptions({ ECHOSPHERE_HOSTED: 'true', RENDER_EXTERNAL_URL: origin }).origin.origin, origin);
});
