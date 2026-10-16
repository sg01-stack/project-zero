import * as processModule from 'node:process';
import * as http from 'node:http';
import { readSettings } from '../server/settings.mjs';
import { join } from 'node:path';

export async function loadRuntime(root, { localConfig = true } = {}) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) throw new Error('Install Node.js 22 or newer from nodejs.org, then launch EchoSphere again.');
  try { if (localConfig) processModule.loadEnvFile(join(root, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('The local .env file could not be loaded. Check its format.'); }
  // Node 24.5+ supports the cloud environment's proxy without CLI flags.
  if (http.setGlobalProxyFromEnv) http.setGlobalProxyFromEnv();
  const env = { ...process.env };
  try {
    const saved = localConfig ? await readSettings(root) : null;
    if (saved && !env.EVOLUS_API_KEY) {
      env.EVOLUS_API_KEY = saved.apiKey;
      env.EVOLUS_AGENT_ID = saved.agentId;
      env.EVOLUS_MODEL = '';
    }
  } catch (error) { console.warn(error.message); }
  return env;
}
