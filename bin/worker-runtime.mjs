import { readAgentConfig, agentConfigPath } from './agent-enrollment.mjs';
import { workerRoot } from './agent-services.mjs';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';

export function loadWorkerConfig(path = agentConfigPath(), root = workerRoot()) {
  const config = readAgentConfig(path);
  if (!config) throw new Error(`Agent is not enrolled (${path} not found). Run deploy agent join.`);
  if (!config.workerId || !config.workerToken || config.workerId === 'local')
    throw new Error(
      'No task-worker credential. Create a new enrollment with Coding tasks enabled and run deploy agent join.',
    );
  const url = new URL(config.coordinatorUrl);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid coordinator origin in agent config.');
  return {
    DEPLOY_COORDINATOR_URL: url.origin,
    DEPLOY_WORKER_ID: config.workerId,
    DEPLOY_WORKER_NAME: config.name,
    DEPLOY_WORKER_TOKEN: config.workerToken,
    DEPLOY_WORKER_ROOT: root,
  };
}
/** Node, provider CLIs, git, curl and Python inherit the same verified OS trust roots. */
export function enableWorkerTlsTrust(root, env = process.env) {
  const certificates = [
    ...new Set([...getCACertificates('default'), ...getCACertificates('system')]),
  ];
  setDefaultCACertificates(certificates);
  // Retain additional roots explicitly configured by the owner.
  const extra = env.NODE_EXTRA_CA_CERTS ? readFileSync(env.NODE_EXTRA_CA_CERTS, 'utf8') : '';
  const file = join(root, 'system-ca.pem');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(file, [...certificates, extra].join('\n'), { mode: 0o600 });
  env.NODE_USE_SYSTEM_CA = '1';
  env.NODE_EXTRA_CA_CERTS = file;
  env.SSL_CERT_FILE = file;
  env.GIT_SSL_CAINFO = file;
  env.CURL_CA_BUNDLE = file;
  env.REQUESTS_CA_BUNDLE = file;
}
