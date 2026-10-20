import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo, hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { loadOrCreateSecretKey, encryptSecret, decryptSecret } from '../secrets.ts';
import { deployDataDirectory } from '../data-directory.ts';
import { enrollWorker } from './credentials.ts';
import { db, list, save, now } from './store.ts';

const children = new Map<string, { child?: ChildProcess; error?: string; nextStart: number }>();
let origin = process.env.DEPLOY_MANAGED_WORKER_ORIGIN || 'https://deploy.local';
let timer: ReturnType<typeof setInterval> | undefined;
let stopping = false;
export function workerIdentity() {
  const current = userInfo();
  if (current.uid !== 0) return current;
  // The installed updater's root-owned configuration explicitly names the ordinary operator.
  const path = '/etc/deploy-local-release.json',
    stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022)
    throw new Error('Worker operator configuration is not trusted');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(config.user)) throw new Error('Invalid worker operator');
  const fields = execFileSync('getent', ['passwd', config.user], { encoding: 'utf8' })
    .trim()
    .split(':');
  if (fields.length !== 7 || !Number(fields[2]) || !fields[5].startsWith('/'))
    throw new Error('An ordinary worker account is required');
  return {
    username: fields[0],
    uid: Number(fields[2]),
    gid: Number(fields[3]),
    homedir: fields[5],
    shell: fields[6],
  };
}
export function managedWorkerStatus(owner: string) {
  const record = list('managed-worker', owner)[0],
    running = record && children.get(owner);
  let available = true,
    reason = '';
  try {
    workerIdentity();
  } catch {
    available = false;
    reason = 'The server needs an ordinary worker account configured by its operator.';
  }
  const worker = record && list('worker', owner).find((w) => w.id === record.id);
  return {
    available,
    reason,
    workerId: record?.id || null,
    enabled: !!record?.enabled,
    status:
      worker && Date.now() - Date.parse(worker.heartbeat) < 10000
        ? 'online'
        : running?.child
          ? 'starting'
          : 'offline',
    error: running?.error || '',
    name: hostname(),
  };
}
export function enableManagedWorker(owner: string) {
  workerIdentity();
  let record = list('managed-worker', owner)[0];
  if (!record) {
    const workerId = 'managed-' + createHash('sha256').update(owner).digest('hex').slice(0, 16);
    const { workerToken } = enrollWorker(owner, { workerId });
    record = {
      id: workerId,
      enabled: true,
      createdAt: now(),
      secret: encryptSecret(
        workerToken,
        loadOrCreateSecretKey(deployDataDirectory()),
        `managed-worker:${owner}:${workerId}`,
      ),
    };
    save('managed-worker', owner, record);
  }
  start(owner, record);
  return managedWorkerStatus(owner);
}
/** Where the account's managed worker keeps its state and task workspaces (`<root>/tasks/<id>`). */
export function managedWorkerRoot(workerId: string, homedir = workerIdentity().homedir) {
  return resolve(homedir, '.local/share/deploy.local/task-workers', workerId);
}
export function managedWorkerLaunch(
  identity: ReturnType<typeof workerIdentity>,
  workerId: string,
  token: string,
  coordinatorOrigin: string,
) {
  if (identity.uid === 0 || !/^[a-zA-Z0-9_-]{1,100}$/.test(workerId))
    throw new Error('An ordinary worker identity is required');
  const root = managedWorkerRoot(workerId, identity.homedir);
  return {
    cwd: identity.homedir,
    uid: identity.uid,
    gid: identity.gid,
    env: {
      PATH: [
        resolve(identity.homedir, '.local/bin'),
        dirname(process.execPath),
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
      ].join(':'),
      HOME: identity.homedir,
      USER: identity.username,
      LOGNAME: identity.username,
      LANG: 'C.UTF-8',
      DEPLOY_COORDINATOR_URL: coordinatorOrigin,
      DEPLOY_WORKER_ID: workerId,
      DEPLOY_WORKER_TOKEN: token,
      DEPLOY_WORKER_ROOT: root,
      DEPLOY_WORKER_NAME: hostname(),
      DEPLOY_MANAGED_WORKER: '1',
      CODEX_HOME: resolve(root, 'providers/codex'),
      DEPLOY_CODEX_AUTH_SOURCE: resolve(identity.homedir, '.codex/auth.json'),
      NODE_EXTRA_CA_CERTS: resolve(deployDataDirectory(), 'certs/ca.crt'),
    },
  };
}
function start(owner: string, record: any) {
  if (stopping || children.get(owner)?.child || Date.now() < (children.get(owner)?.nextStart || 0))
    return;
  try {
    const identity = workerIdentity();
    const executable = fileURLToPath(
      new URL(
        import.meta.url.endsWith('.ts') ? './remote-worker.ts' : './workspace-remote-worker.js',
        import.meta.url,
      ),
    );
    const token = decryptSecret(
      record.secret,
      loadOrCreateSecretKey(deployDataDirectory()),
      `managed-worker:${owner}:${record.id}`,
    );
    const child = spawn(process.execPath, [executable], {
      ...managedWorkerLaunch(identity, record.id, token, origin),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.set(owner, { child, nextStart: 0 });
    // Do not copy provider output or credentials into control-plane logs.
    child.stdout?.resume();
    child.stderr?.resume();
    child.once('error', () =>
      children.set(owner, {
        error: 'Task worker could not start. Retry or inspect the server runtime.',
        nextStart: Date.now() + 5000,
      }),
    );
    child.once('exit', (code) =>
      children.set(owner, {
        error: stopping ? '' : `Task worker exited (${code ?? 'signal'}). Retrying.`,
        nextStart: Date.now() + 5000,
      }),
    );
  } catch (error) {
    children.set(owner, { error: (error as Error).message, nextStart: Date.now() + 5000 });
  }
}
export function startManagedWorkers(coordinatorOrigin: string) {
  origin = coordinatorOrigin;
  stopping = false;
  const tick = () => {
    for (const row of db
      .prepare("SELECT owner,data FROM records WHERE kind='managed-worker'")
      .all() as any[]) {
      const record = JSON.parse(row.data);
      if (record.enabled) start(row.owner, record);
    }
  };
  tick();
  timer ||= setInterval(tick, 5000);
  timer.unref();
}
export function stopManagedWorkers() {
  stopping = true;
  clearInterval(timer);
  timer = undefined;
  for (const { child } of children.values()) child?.kill('SIGTERM');
}
