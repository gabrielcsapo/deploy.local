import { Agent, fetch as request } from 'undici';
import tls from 'node:tls';
import { isIP } from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoordinatorClient, validPin } from './client.mjs';
const origin = process.env.DEPLOY_COORDINATOR_URL;
const pin = process.env.DEPLOY_DESKTOP_PIN;
const client = new CoordinatorClient(origin, { pin });
const caPath = join(process.env.DEPLOY_WORKER_ROOT, 'coordinator-ca.pem');
if (pin) {
  // Fetch the issuer only over the already fingerprint-verified connection.
  writeFileSync(caPath, await client.request('/ca.crt', { raw: true }), { mode: 0o600 });
  for (const name of ['spawn', 'spawnSync']) {
    const original = childProcess[name];
    childProcess[name] = (command, args, options) =>
      original(
        command,
        command === 'git' ? ['-c', `http.${origin}/.sslCAInfo=${caPath}`, ...args] : args,
        options,
      );
  }
  syncBuiltinESMExports();
}
const dispatcher = pin
  ? new Agent({
      connect(options, callback) {
        const socket = tls.connect({
          host: options.hostname,
          port: Number(options.port || 443),
          servername: isIP(options.hostname) ? undefined : options.servername || options.hostname,
          rejectUnauthorized: false,
        });
        let done = false;
        const finish = (error) => {
          if (!done) {
            done = true;
            callback(error, error ? null : socket);
          }
        };
        socket.once('error', finish);
        socket.once('secureConnect', () => {
          if (validPin(socket.getPeerCertificate().raw, pin)) finish(null);
          else {
            finish(new Error('Coordinator certificate changed or expired.'));
            socket.destroy();
          }
        });
      },
    })
  : undefined;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url || input);
  if (url.origin !== origin) return originalFetch(input, init);
  try {
    const response = await request(input, { ...init, dispatcher, redirect: 'error' });
    if (url.pathname.endsWith('/controls/poll') && response.ok) {
      const value = await response.clone().json();
      process.send?.({
        type: 'controls',
        taskIds: value.sessions.map((session) => session.taskId),
      });
    }
    if (url.pathname.endsWith('/workers/register'))
      process.send?.({ type: 'heartbeat', online: response.ok });
    return response;
  } catch (error) {
    process.send?.({ type: 'heartbeat', online: false });
    throw error;
  }
};
await import('../../server/workspace/remote-worker.ts');
