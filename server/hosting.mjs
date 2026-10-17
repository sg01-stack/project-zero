import { randomBytes } from 'node:crypto';

export function hostingOptions(env) {
  const hosted = env.ECHOSPHERE_HOSTED === 'true';
  if (!hosted) return { hosted: false };
  const origin = new URL(env.PUBLIC_ORIGIN || env.RENDER_EXTERNAL_URL || '');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Hosted mode requires PUBLIC_ORIGIN (or RENDER_EXTERNAL_URL) to be the HTTPS origin of this app.');
  }
  const hourlyLimit = Number(env.MAX_AGENT_CALLS_PER_HOUR || 60);
  if (!Number.isInteger(hourlyLimit) || hourlyLimit < 1 || hourlyLimit > 10000) throw new Error('MAX_AGENT_CALLS_PER_HOUR must be between 1 and 10000.');
  return { hosted: true, origin, hourlyLimit };
}

// A single-instance demo: bounded visitor state and shared upstream-call budget.
// Deploying multiple instances requires a shared session/rate-limit store.
export function createVisitorAccess(options, now = Date.now) {
  const visitors = new Map();
  let windowStart = now(), calls = 0;
  function visitor(req, res, create = false) {
    if (!options.hosted) return 'local';
    for (const [id, value] of visitors) if (value.expires <= now()) visitors.delete(id);
    let id = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('echosphere_visitor='))?.slice(19);
    if (id && visitors.has(id)) return id;
    if (!create) throw Object.assign(new Error('Reload the demo to start a visitor session.'), { statusCode: 401 });
    if (visitors.size >= 512) throw Object.assign(new Error('The demo is busy. Please try again later.'), { statusCode: 429 });
    id = randomBytes(24).toString('hex');
    visitors.set(id, { expires: now() + 4 * 3600000, calls: 0, window: now() });
    res.setHeader('Set-Cookie', `echosphere_visitor=${id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=14400`);
    return id;
  }
  function consume(id) {
    if (!options.hosted) return;
    if (now() - windowStart >= 3600000) { windowStart = now(); calls = 0; }
    const value = visitors.get(id);
    if (!value) throw Object.assign(new Error('Reload the demo to renew your session.'), { statusCode: 401 });
    if (now() - value.window >= 3600000) { value.calls = 0; value.window = now(); }
    if (calls >= options.hourlyLimit || value.calls >= 20) {
      throw Object.assign(new Error('The live demo has reached its hourly request limit. You can still use the offline demo.'), { statusCode: 429 });
    }
    calls++; value.calls++;
  }
  return { visitor, consume };
}
