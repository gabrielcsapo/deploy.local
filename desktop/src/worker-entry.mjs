import { Agent, fetch as request } from 'undici';
import tls from 'node:tls';
import { isIP } from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoordinatorClient, certificateError, certificateProblem } from './client.mjs';
const origin = process.env.DEPLOY_COORDINATOR_URL;
const ca = process.env.DEPLOY_DESKTOP_CA || undefined;
const pin = ca ? undefined : process.env.DEPLOY_DESKTOP_PIN || undefined;
const trust = { ca, pin };
const client = new CoordinatorClient(origin, trust);
const caPath = join(process.env.DEPLOY_WORKER_ROOT, 'coordinator-ca.pem');
if (ca || pin) {
  // An older setup fetches the issuer only over the already fingerprint-verified connection.
  writeFileSync(caPath, ca || (await client.request('/ca.crt', { raw: true })), { mode: 0o600 });
  // Agents and the deploy tool server run as their own processes and reach the
  // coordinator directly, so they trust the same verified issuer.
  process.env.NODE_EXTRA_CA_CERTS = caPath;
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
const dispatcher =
  ca || pin
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
            const problem = certificateProblem(
              socket.getPeerCertificate().raw,
              trust,
              options.hostname,
            );
            if (!problem) finish(null);
            else {
              finish(certificateError(problem));
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
