import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createEvolusClient, listEvolusModels, resolveAgentModel, DEFAULT_AGENT_ID } from './evolus.mjs';
import { saveSettings, validateSettings } from './settings.mjs';
import { hostingOptions, createVisitorAccess } from './hosting.mjs';

const types = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json' };
const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
};

function validatePayload(p) {
  if (!p || p.schema_version !== '1.0' || !['user_turn_complete', 'user_text'].includes(p.event) ||
      typeof p.turn_id !== 'string' || !p.turn_id.length || p.turn_id.length > 160 ||
      typeof p.session_id !== 'string' || !p.session_id.length || p.session_id.length > 128 ||
      (p.event === 'user_turn_complete' && (!['voiced_speech', 'whisper_like', 'uncertain_audio'].includes(p.prosody_analysis?.dominant_style) ||
      !Number.isFinite(p.prosody_analysis?.average_rms_dbfs))) ||
      (p.event === 'user_text' && (p.prosody_analysis !== null || typeof p.transcript?.text !== 'string' || !p.transcript.text.trim())) ||
      (p.transcript !== null && (typeof p.transcript?.text !== 'string' || p.transcript.text.length > 20000))) {
    throw Object.assign(new Error('Invalid EchoSphere turn payload.'), { statusCode: 400 });
  }
}

async function readJson(req, limit = 65536) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw Object.assign(new Error('Expected application/json.'), { statusCode: 415 });
  }
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('JSON payload is too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw Object.assign(new Error('Invalid JSON.'), { statusCode: 400 });
  }
}

export function createApplicationServer({ root, env = process.env, completeTurn, listModels, persistSettings = saveSettings } = {}) {
  const hosting = hostingOptions(env);
  const access = createVisitorAccess(hosting);
  let agentId = env.EVOLUS_AGENT_ID || DEFAULT_AGENT_ID;
  let apiKey = env.EVOLUS_API_KEY;
  let preferredModel = env.EVOLUS_MODEL;
  const setupToken = randomBytes(24).toString('hex');
  let configuring = false, checking = false;
  const discoverModels = key => listModels ? listModels(key) : listEvolusModels({ apiKey: key });
  let selectedModel = null, discovery = null, liveVerified = false;
  async function ensureAgent() {
    if (configuring) throw Object.assign(new Error('Agent setup is in progress. Try again when it finishes.'), { statusCode: 503 });
    if (!apiKey) throw Object.assign(new Error(hosting.hosted ? 'The demo owner needs to configure its Evolus key. The offline demo is still available.' : 'Connect your Evolus key using the setup form below, or explore the offline demo.'), { statusCode: 503 });
    if (selectedModel) return selectedModel;
    if (!discovery) discovery = Promise.resolve().then(() => discoverModels(apiKey)).then(ids => {
      selectedModel = resolveAgentModel(ids, { agentId, preferredModel });
      return selectedModel;
    }).finally(() => { discovery = null; });
    return discovery;
  }

  // Retry protection and story context are intentionally bounded and local.
  // A restart clears them; production deployment needs durable storage.
  const completed = new Map(), inflight = new Map(), sessions = new Map(), busySessions = new Set();
  return http.createServer(async (req, res) => {
    try {
      // Health probes carry no credentials and may use the platform's internal host.
      if (req.url === '/api/health' && req.method === 'GET') return json(res, 200, { app: 'EchoSphere', version: '1.2' });
      const base = hosting.hosted ? hosting.origin : new URL(`http://${req.headers.host}`);
      if (hosting.hosted ? req.headers.host !== base.host : !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) return json(res, 403, { error: 'Invalid application host.' });
      if (req.headers.origin && req.headers.origin !== base.origin) return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
      res.setHeader('Referrer-Policy', 'same-origin');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Permissions-Policy', 'microphone=(self), camera=()');
      const pathname = decodeURIComponent(new URL(req.url, base).pathname);
      if (pathname === '/api/status' && req.method === 'GET') {
        access.visitor(req, res, true);
        let error = null;
        try { await ensureAgent(); } catch (e) { error = e.statusCode ? e.message : 'Could not resolve the configured agent.'; }
        return json(res, 200, {
          app: 'EchoSphere', setup_token: setupToken, hosted: hosting.hosted, setup_allowed: !hosting.hosted,
          configured: Boolean(selectedModel), missing: apiKey ? [] : ['EVOLUS_API_KEY'],
          agent_id: agentId, selected_model: selectedModel, provider: 'Evolus', integration_mode: 'agent',
          agent_route_verified: Boolean(selectedModel), live_connection_verified: liveVerified, error,
        });
      }
      if (['/api/config', '/api/check'].includes(pathname) && req.method === 'POST') {
        if (pathname === '/api/config' && hosting.hosted) return json(res, 403, { error: 'Hosted credentials are managed by the demo owner.' });
        const visitorId = access.visitor(req, res);
        if (req.headers['x-echosphere-token'] !== setupToken) return json(res, 403, { error: 'Reload the app before changing or testing its connection.' });
        const body = await readJson(req, 4096);
        if (configuring || checking || inflight.size || discovery) return json(res, 409, { error: 'Wait for the current agent request to finish, then retry.' });
        if (pathname === '/api/config') {
          const candidate = validateSettings({ apiKey: typeof body?.apiKey === 'string' ? body.apiKey.trim() : body?.apiKey, agentId: body?.agentId || agentId });
          configuring = true;
          try {
            const model = resolveAgentModel(await discoverModels(candidate.apiKey), { agentId: candidate.agentId });
            await persistSettings(root, candidate, body.remember === true);
            apiKey = candidate.apiKey; agentId = candidate.agentId; preferredModel = model;
            selectedModel = model; liveVerified = false;
            sessions.clear(); completed.clear();
            return json(res, 200, { configured: true, agent_id: agentId, remembered: body.remember === true });
          } finally { configuring = false; }
        }
        checking = true;
        try {
          const model = await ensureAgent();
          access.consume(visitorId);
          const payload = { schema_version: '1.0', event: 'connection_test', turn_id: `check:${randomUUID()}`,
            transcript: { text: 'This is a connection test. Reply briefly in English to confirm you are ready for an interactive story.' },
            llm_guidance: 'No microphone audio is included in this connection test.' };
          const result = completeTurn ? await completeTurn(payload, model, []) : await createEvolusClient({ apiKey, model })(payload);
          if (typeof result?.reply !== 'string' || !result.reply.trim()) throw Object.assign(new Error('The agent returned no text.'), { statusCode: 502 });
          liveVerified = true;
          return json(res, 200, { verified: true, reply: result.reply, agent_id: agentId });
        } finally { checking = false; }
      }
      if (pathname === '/api/turn' && req.method === 'POST') {
        const visitorId = access.visitor(req, res);
        const payload = await readJson(req);
        validatePayload(payload);
        const model = await ensureAgent();
        const id = hosting.hosted ? `${visitorId}:${payload.turn_id}` : payload.turn_id;
        const sessionKey = hosting.hosted ? `${visitorId}:${payload.session_id}` : payload.session_id;
        const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
        const existing = completed.get(id) || inflight.get(id);
        if (existing && existing.hash !== hash) return json(res, 409, { error: 'Turn ID was reused with different content.' });
        if (completed.has(id)) return json(res, 200, completed.get(id).result);
        if (!inflight.has(id)) {
          if (inflight.size >= 4) return json(res, 429, { error: 'Too many pending agent calls. Retry later.' });
          if (busySessions.has(sessionKey)) return json(res, 409, { error: 'Wait for the previous turn in this session, then retry.' });
          access.consume(visitorId);
          busySessions.add(sessionKey);
          const history = sessions.get(sessionKey) || [];
          const promise = Promise.resolve().then(() => completeTurn
            ? completeTurn(payload, model, structuredClone(history))
            : createEvolusClient({ apiKey, model })(payload, history)
          ).then(response => {
            if (response?.turn_id !== payload.turn_id || typeof response.reply !== 'string' || !response.reply.trim()) {
              throw Object.assign(new Error('The agent returned an invalid response.'), { statusCode: 502 });
            }
            const result = { ...response, agent_id: agentId };
            liveVerified = true;
            const next = [...history, { role: 'user', content: JSON.stringify(payload) }, { role: 'assistant', content: result.reply }].slice(-12);
            sessions.delete(sessionKey);
            sessions.set(sessionKey, next);
            if (sessions.size > 32) sessions.delete(sessions.keys().next().value);
            completed.set(id, { hash, result });
            if (completed.size > 256) completed.delete(completed.keys().next().value);
            return result;
          }).finally(() => { inflight.delete(id); busySessions.delete(sessionKey); });
          inflight.set(id, { hash, promise });
        }
        return json(res, 200, await inflight.get(id).promise);
      }
      if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Unknown API route or method.' });
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
      const allowed = pathname === '/' || pathname === '/index.html' || pathname === '/style.css' || pathname === '/dist/echosphere.html' ||
        ['/dist/app.js', '/src/app.mjs', '/src/audio-engine.mjs', '/src/capture.mjs', '/src/experience.mjs', '/src/visuals.mjs'].includes(pathname);
      const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!allowed || !path.startsWith(root.endsWith(sep) ? root : root + sep)) { res.writeHead(404); return res.end('Not found'); }
      const data = await readFile(path);
      res.writeHead(200, { 'Content-Type': `${types[extname(path)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (!res.headersSent) json(res, error.statusCode || 500, { error: error.statusCode ? error.message : 'Request could not be processed.' });
      else res.end();
    }
  });
}
