import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSettings, saveSettings } from '../server/settings.mjs';
import { DEFAULT_AGENT_ID } from '../server/evolus.mjs';

test('remembered settings reload after restart and session-only setup removes the saved key', async t => {
  const root = await mkdtemp(join(tmpdir(), 'echosphere-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await readSettings(root), null);
  const config = { apiKey: 'test-only-placeholder', agentId: DEFAULT_AGENT_ID };
  await saveSettings(root, config, true);
  assert.deepEqual(await readSettings(root), config);
  if (process.platform !== 'win32') assert.equal((await stat(join(root, '.echosphere.local.json'))).mode & 0o777, 0o600);
  await saveSettings(root, config, false);
  assert.equal(await readSettings(root), null);
});
