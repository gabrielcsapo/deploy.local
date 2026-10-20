import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform, arch } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export function userAgentConfigPath(env = process.env, home = homedir()) {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'deploy.local/agent.json');
}
export function agentConfigPath() {
  if (process.env.DEPLOY_AGENT_CONFIG) return resolve(process.env.DEPLOY_AGENT_CONFIG);
  if (platform() === 'darwin')
    return join(homedir(), 'Library/Application Support/deploy.local/agent.json');
  const user = userAgentConfigPath();
  return existsSync(user) ? user : '/var/lib/deploy.local/agent.json';
}
export function readAgentConfig(path = agentConfigPath()) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
/** Enrollment and private credential storage shared by `deploy agent join` and Node setup. */
export async function joinAgent({
  coordinatorUrl,
  code,
  name,
  capabilities = {},
  version,
  taskWorker = false,
  configPath = agentConfigPath(),
  request = fetch,
}) {
  const url = new URL(coordinatorUrl);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Use the coordinator origin, for example https://deploy.local');
  const response = await request(`${url.origin}/api/agent/enroll`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      name,
      platform: platform(),
      architecture: arch(),
      agentVersion: version,
      capabilities,
      taskWorker,
    }),
  });
  // Never include server response text: an upstream error might echo credentials.
  if (!response.ok)
    throw new Error(
      `Enrollment failed (${response.status}). Check the code and coordinator address.`,
    );
  const enrolled = await response.json();
  if (
    !enrolled.nodeId ||
    !enrolled.secret ||
    (taskWorker && (!enrolled.workerId || !enrolled.workerToken))
  )
    throw new Error(
      'The coordinator does not support Node enrollment. Update it and create a new enrollment.',
    );
  const config = {
    coordinatorUrl: url.origin,
    nodeId: enrolled.nodeId,
    name: enrolled.name,
    secret: enrolled.secret,
    ...(taskWorker ? { workerId: enrolled.workerId, workerToken: enrolled.workerToken } : {}),
  };
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  chmodSync(configPath, 0o600);
  return config;
}
