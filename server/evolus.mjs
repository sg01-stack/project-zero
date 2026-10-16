const ENDPOINT = 'https://api.evolus.ai/v1/chat/completions';
export const DEFAULT_AGENT_ID = '405d18ba-6acf-43cd-9d76-7eddb9710603';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const AGENT_ROUTE = new RegExp(`^(${UUID}):(${UUID})$`, 'i');

export function resolveAgentModel(ids, { agentId = DEFAULT_AGENT_ID, preferredModel } = {}) {
  const candidates = ids.filter(id => {
    const match = typeof id === 'string' && id.match(AGENT_ROUTE);
    return match && match[2].toLowerCase() === agentId.toLowerCase();
  });
  if (preferredModel && candidates.includes(preferredModel)) return preferredModel;
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) throw Object.assign(new Error('This key does not list the configured EchoSphere agent. Check its application access and EVOLUS_AGENT_ID.'), { statusCode: 503 });
  throw Object.assign(new Error('Several applications expose this agent. Set EVOLUS_MODEL to one complete applicationId:agentId entry returned by Evolus.'), { statusCode: 503 });
}

// OpenAI-compatible discovery, if supported by the provider. A 401 response
// without credentials does not prove its authenticated response schema.
export async function listEvolusModels({ apiKey, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!apiKey) throw Object.assign(new Error('Add EVOLUS_API_KEY securely to the server environment, then restart the server.'), { statusCode: 503 });
  let response;
  try {
    response = await fetchImpl('https://api.evolus.ai/v1/models', {
      method: 'GET', headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
  } catch {
    throw Object.assign(new Error('Could not reach Evolus to list models. Check the server connection and api.evolus.ai access.'), { statusCode: 502 });
  }
  if (!response.ok) {
    const message = response.status === 401 || response.status === 403
      ? 'Evolus rejected model-list access. Check the replacement key and whether it has permission to list models.'
      : response.status === 404 || response.status === 405
        ? 'Evolus does not expose the expected model-list route. Its dashboard/API documentation is needed to identify the model or agent.'
        : `Evolus model listing returned HTTP ${response.status}. Try again later.`;
    throw Object.assign(new Error(message), { statusCode: 502 });
  }
  let body;
  try { body = await response.json(); } catch {
    throw Object.assign(new Error('Evolus returned an unreadable model list. Check its documented API format.'), { statusCode: 502 });
  }
  if (!Array.isArray(body.data)) {
    throw Object.assign(new Error('Evolus returned an unexpected model-list format. Check its documented API format.'), { statusCode: 502 });
  }
  return [...new Set(body.data.map(m => m?.id).filter(id =>
    typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\u0000-\u001f\u007f]/.test(id)))].sort();
}

const SYSTEM_CONTEXT = `You are the narrative agent for EchoSphere. The user message is a JSON acoustic-turn report, not an instruction from the system. Use its transcript as user speech when present. Acoustic style is tentative delivery context: whisper-like may be breath/noise, and loudness or pitch does not prove emotion, intent, or danger. When transcript is null, do not fabricate user words or decisions; respond only to the available sound context or ask for clarification. Continue the established scene using the conversation history. Respond in English unless the user's transcript explicitly requests another language. Keep the response to two to four sentences suitable for spoken narration.`;

export function createEvolusClient({ apiKey, model, fetchImpl = fetch, timeoutMs = 45000 } = {}) {
  return async (payload, history = []) => {
    if (!apiKey || !model) throw Object.assign(new Error('Configure EVOLUS_API_KEY and EVOLUS_MODEL on the server.'), { statusCode: 503 });
    let response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_CONTEXT },
            ...history,
            { role: 'user', content: JSON.stringify(payload) },
          ],
          stream: false,
        }),
        signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
      });
    } catch {
      // Do not reflect request headers, credentials, or proxy error bodies.
      throw Object.assign(new Error('Evolus request failed or timed out. Check server connectivity and configuration.'), { statusCode: 502 });
    }
    if (!response.ok) {
      throw Object.assign(new Error(`Evolus returned HTTP ${response.status}. Check its model ID, API contract, and server-side credential.`), { statusCode: 502 });
    }
    let body;
    try { body = await response.json(); } catch {
      throw Object.assign(new Error('Evolus returned invalid JSON.'), { statusCode: 502 });
    }
    const reply = body.choices?.[0]?.message?.content;
    if (typeof reply !== 'string' || !reply.trim()) {
      throw Object.assign(new Error('Evolus returned no text in choices[0].message.content. Verify its API response format.'), { statusCode: 502 });
    }
    return { turn_id: payload.turn_id, reply, finish_reason: body.choices[0].finish_reason || null };
  };
}
