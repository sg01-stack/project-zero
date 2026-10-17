import { fileURLToPath } from 'node:url';
import { createApplicationServer } from '../server/app.mjs';
import { loadRuntime } from './runtime.mjs';
import { spawn } from 'node:child_process';
import { hostingOptions } from '../server/hosting.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
try {
  const env = await loadRuntime(root, { localConfig: !process.argv.includes('--no-local-config') });
  const hosting = hostingOptions(env);
  const bindHost = hosting.hosted ? '0.0.0.0' : '127.0.0.1';
  const port = Number(env.PORT || 8000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a number between 0 and 65535.');
  const server = createApplicationServer({ root, env });
  let retriedPort = false;
  server.on('error', error => {
    if (error.code === 'EADDRINUSE' && !retriedPort && !hosting.hosted) {
      retriedPort = true;
      server.listen(0, '127.0.0.1');
    } else {
      console.error(`EchoSphere could not start (${error.code || 'server error'}). Close any old EchoSphere window and try again.`);
      process.exitCode = 1;
    }
  });
  server.on('listening', () => {
    const address = hosting.hosted ? hosting.origin.origin : `http://127.0.0.1:${server.address().port}`;
    console.log(`EchoSphere is running. Open ${address} in Edge or Chrome.\nKeep this process running. Press Ctrl+C to stop.`);
    if (process.argv.includes('--open') && !hosting.hosted) {
      const [program, args] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/c', 'start', '', address]]
        : process.platform === 'darwin' ? ['open', [address]] : ['xdg-open', [address]];
      const opener = spawn(program, args, { stdio: 'ignore', detached: true });
      opener.on('error', () => console.log('Open the printed local address in your browser.'));
      opener.unref();
    }
  });
  server.listen(port, bindHost);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
