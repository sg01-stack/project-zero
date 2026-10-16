import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const filename = '.echosphere.local.json';
export function validateSettings(value) {
  if (!value || typeof value.apiKey !== 'string' || value.apiKey.length < 8 || value.apiKey.length > 512 || /\s/.test(value.apiKey)) {
    throw Object.assign(new Error('Enter a valid Evolus API key in the local setup form.'), { statusCode: 400 });
  }
  if (typeof value.agentId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.agentId)) {
    throw Object.assign(new Error('Enter the agent ID from its Evolus page address.'), { statusCode: 400 });
  }
  return { apiKey: value.apiKey, agentId: value.agentId };
}

export async function readSettings(root) {
  try { return validateSettings(JSON.parse(await readFile(join(root, filename), 'utf8'))); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Saved EchoSphere settings could not be read. Remove .echosphere.local.json and reconnect using the app.');
  }
}

export async function saveSettings(root, value, remember) {
  const path = join(root, filename);
  if (!remember) { await rm(path, { force: true }); return; }
  const settings = validateSettings(value);
  const temp = path + '.tmp';
  try {
    await writeFile(temp, JSON.stringify(settings), { mode: 0o600 });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}
