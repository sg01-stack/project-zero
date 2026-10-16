import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';

test('launcher starts without a key and chooses a free port if its requested port is occupied', async t => {
  const occupied = http.createServer((req, res) => res.end('another service'));
  occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening');
  t.after(() => { occupied.closeAllConnections(); occupied.close(); });
  const child = spawn(process.execPath, ['scripts/serve.mjs', '--no-local-config'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, EVOLUS_API_KEY: '', EVOLUS_AGENT_ID: '', EVOLUS_MODEL: '', PORT: String(occupied.address().port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  const address = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Launcher startup timed out')), 10000);
    child.stdout.on('data', data => {
      const match = data.toString().match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Launcher exited: ${code}`)); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  assert.notEqual(new URL(address).port, String(occupied.address().port));
  assert.equal((await (await fetch(`${address}/api/health`)).json()).app, 'EchoSphere');
  const status = await (await fetch(`${address}/api/status`)).json();
  assert.equal(status.configured, false); assert.deepEqual(status.missing, ['EVOLUS_API_KEY']);
  assert.ok((await (await fetch(address)).text()).includes('id="agentForm"'));
});
