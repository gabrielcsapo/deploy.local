import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chownSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
  closeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { userInfo } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  SelfUpdateChange,
  SelfUpdateRun,
  SelfUpdateStatus,
} from '../../shared/v2/contracts.ts';
import { isAdmin } from '../store.ts';
import { list } from '../workspace/store.ts';
import { gitSync } from '../workspace/repository-git.ts';
import { fail } from './inbox.ts';
import { getComputers } from './computers.ts';

/** Written once by `scripts/linux-release.mjs install`; its absence means this host has no deploy-update. */
export type ReleaseConfig = {
  user: string;
  uid: number;
  releases: string;
  current: string;
  data: string;
  node: string;
};
const configPath = () => process.env.DEPLOY_RELEASE_CONFIG || '/etc/deploy-local-release.json';
const DEFAULT_ESTIMATE_MS = 6 * 60_000;
const STARTUP_GRACE_MS = 20_000;

export function readReleaseConfig(path = configPath()): ReleaseConfig | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
const stateDirectory = (config: ReleaseConfig) => join(dirname(config.current), 'self-update');
const stateFile = (config: ReleaseConfig) => join(stateDirectory(config), 'current.json');
const readJson = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
};
export function runningRevision(config: ReleaseConfig) {
  return readJson<{ revision?: string }>(join(config.current, '.deploy-release.json'))?.revision;
}

/** The project whose main contains what this coordinator runs; deploy.local hosts its own source. */
export function findSourceRepository(
  repositories: { name: string; path: string }[],
  running: string,
) {
  const candidates = repositories
    .filter(({ path }) => path && existsSync(path))
    .sort((a, b) => Number(b.name === 'deploy.local') - Number(a.name === 'deploy.local'));
  return candidates.find(
    ({ path }) =>
      gitSync(path, ['merge-base', '--is-ancestor', running, 'refs/heads/main']) !== null,
  );
}
export function changesSince(path: string, running: string) {
  const main = gitSync(path, ['rev-parse', '--verify', 'refs/heads/main^{commit}']) || '';
  const ahead = Number(
    gitSync(path, ['rev-list', '--first-parent', '--count', `${running}..${main}`]) || 0,
  );
  const changes: SelfUpdateChange[] = (
    gitSync(path, [
      'log',
      '--first-parent',
      '-n',
      '50',
      '--format=%H%x00%s%x00%cI',
      `${running}..${main}`,
    ]) || ''
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject, date] = line.split('\0');
      return { sha, subject, date };
    });
  return { main, ahead, changes };
}

const unitName = (id: string) => `deploy-self-update-${id.slice(0, 8)}`;
function unitActive(id: string) {
  return spawnSync('systemctl', ['is-active', '--quiet', unitName(id)]).status === 0;
}
/** A run whose updater process is gone without finishing: done if the target is serving. */
export function settleRun(
  run: SelfUpdateRun | undefined,
  running: string,
  active: (id: string) => boolean,
  now = Date.now(),
): SelfUpdateRun | undefined {
  if (!run || run.state !== 'running') return run;
  if (now - Date.parse(run.startedAt) < STARTUP_GRACE_MS || active(run.id)) return run;
  if (running === run.to)
    return {
      ...run,
      state: 'done',
      steps: run.steps.map((step) => ({ ...step, state: 'done' })),
    };
  return {
    ...run,
    state: 'failed',
    error: 'The updater stopped before it finished.',
    steps: run.steps.map((step) =>
      step.state === 'running'
        ? { ...step, state: 'failed', detail: 'stopped unexpectedly' }
        : step.state === 'waiting'
          ? { ...step, state: 'skipped', detail: 'skipped' }
          : step,
    ),
  };
}
export function estimate(history: SelfUpdateRun[] = []) {
  const last = history.findLast((run) => run.state === 'done' && run.finishedAt);
  return last ? Date.parse(last.finishedAt!) - Date.parse(last.startedAt) : DEFAULT_ESTIMATE_MS;
}

type Context =
  | { reason: string }
  | { config: ReleaseConfig; running: string; repository: { name: string; path: string } };
function context(owner: string): Context {
  if (!isAdmin(owner)) return { reason: 'Only an administrator can update deploy.local.' };
  const config = readReleaseConfig();
  if (!config) return { reason: 'This computer was not set up with deploy-update.' };
  const running = runningRevision(config);
  if (!running) return { reason: 'The running release has no verified revision.' };
  const repository = findSourceRepository(
    list('project', owner).map((project) => ({
      name: project.name,
      path: project.repositoryPath,
    })),
    running,
  );
  if (!repository)
    return {
      reason: `No project's main contains the running version ${running.slice(0, 7)}.`,
    };
  return { config, running, repository };
}

/** The run as the page sees it; its plan holds server paths. */
function withoutPlan(run?: SelfUpdateRun & { plan?: unknown }): SelfUpdateRun | undefined {
  if (!run) return undefined;
  const { plan: _plan, ...rest } = run;
  return rest;
}
export function selfUpdateStatus(owner: string): SelfUpdateStatus {
  const found = context(owner);
  if ('reason' in found) return { supported: false, reason: found.reason };
  const { config, running, repository } = found;
  const directory = stateDirectory(config);
  return {
    supported: true,
    computer: getComputers(owner).find((c) => c.roles.includes('coordinator'))?.name || 'SER',
    running,
    ...changesSince(repository.path, running),
    run: settleRun(withoutPlan(readJson(stateFile(config))), running, unitActive),
    estimateMs: estimate(readJson<SelfUpdateRun[]>(join(directory, 'history.json'))),
  };
}

function account(user: string) {
  const line = readFileSync('/etc/passwd', 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith(`${user}:`));
  const [, , uid, gid, , home] = line?.split(':') || [];
  if (home) return { uid: Number(uid), gid: Number(gid), home };
  // Directory-service accounts (macOS) are not in /etc/passwd; the server may run as the deployer.
  const self = userInfo();
  if (self.username === user) return { uid: self.uid, gid: self.gid, home: self.homedir };
  fail(`The deploy account ${user} was not found.`, 500);
}
function releaseName(config: ReleaseConfig, to: string) {
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const name = `${day}-main-${to.slice(0, 7)}`;
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name}-${n}`;
    if (!existsSync(join(config.releases, candidate))) return join(config.releases, candidate);
  }
}

export function startSelfUpdate(owner: string, to: unknown): SelfUpdateStatus {
  const found = context(owner);
  if ('reason' in found) fail(found.reason, 409);
  const { config, running, repository } = found;
  const status = selfUpdateStatus(owner);
  if (!status.supported) fail(status.reason, 409);
  if (status.run?.state === 'running') fail('An update is already running.', 409);
  if (typeof to !== 'string' || to !== status.main)
    fail('main moved since this page loaded. Look at the new changes and try again.', 409);
  if (!status.ahead) fail(`${status.computer} already runs main.`, 409);
  const runner = join(realpathSync(config.current), 'scripts', 'self-update.mjs');
  if (!existsSync(runner)) fail('The running release has no updater. Update it by hand once.', 409);
  const { uid, gid, home } = account(config.user);
  const directory = stateDirectory(config);
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  chownSync(directory, uid, gid);
  const id = randomUUID();
  const run: SelfUpdateRun & { plan: Record<string, string> } = {
    id,
    from: running,
    to,
    state: 'running',
    startedAt: new Date().toISOString(),
    startedBy: owner,
    steps: (['prepare', 'backup', 'restart', 'check'] as const).map((step) => ({
      id: step,
      state: 'waiting',
    })),
    plan: {
      repository: repository.path,
      release: releaseName(config, to),
      current: config.current,
      data: config.data,
      computer: getComputers(owner).find((c) => c.roles.includes('coordinator'))?.name || 'SER',
      log: join(directory, `${id}.log`),
      history: join(directory, 'history.json'),
    },
  };
  const file = stateFile(config);
  writeFileSync(`${file}.tmp`, JSON.stringify(run, null, 2), { mode: 0o644 });
  chownSync(`${file}.tmp`, uid, gid);
  renameSync(`${file}.tmp`, file);
  // A transient unit of its own: restarting deploy-server.service must not stop the updater.
  const result = spawnSync(
    'systemd-run',
    [
      `--unit=${unitName(id)}`,
      `--uid=${uid}`,
      `--gid=${gid}`,
      '--collect',
      '--quiet',
      `--working-directory=${home}`,
      `--setenv=HOME=${home}`,
      `--setenv=PATH=${dirname(config.node)}:/usr/local/bin:/usr/bin:/bin`,
      config.node,
      runner,
      file,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    writeFileSync(
      file,
      JSON.stringify({
        ...run,
        state: 'failed',
        finishedAt: new Date().toISOString(),
        error: `The updater did not start (${(result.stderr || result.error?.message || 'no reason given').trim()}).`,
        steps: run.steps.map((step) => ({ ...step, state: 'skipped', detail: 'skipped' })),
      }),
    );
  }
  return selfUpdateStatus(owner);
}

export function selfUpdateLog(owner: string) {
  const found = context(owner);
  if ('reason' in found) fail(found.reason, 409);
  const run = readJson<SelfUpdateRun>(stateFile(found.config));
  if (!run) return { text: '' };
  const path = join(stateDirectory(found.config), `${run.id}.log`);
  if (!existsSync(path)) return { text: '' };
  const size = statSync(path).size;
  const length = Math.min(size, 64 * 1024);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  return { text: buffer.toString('utf8') };
}

export async function selfUpdateApi(req: IncomingMessage, res: ServerResponse, owner: string) {
  const path = new URL(req.url!, 'http://localhost').pathname.slice('/api/v2'.length);
  if (path !== '/self-update' && path !== '/self-update/log') return false;
  const send = (value: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
    return true;
  };
  if (path === '/self-update/log' && req.method === 'GET') return send(selfUpdateLog(owner));
  if (path === '/self-update' && req.method === 'GET') return send(selfUpdateStatus(owner));
  if (path === '/self-update' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length;
      if (bytes > 4096) {
        req.resume();
        fail('Request too large', 413);
      }
      chunks.push(Buffer.from(chunk));
    }
    let input: { to?: unknown } = {};
    try {
      input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    } catch {
      fail('Invalid JSON');
    }
    return send(startSelfUpdate(owner, input.to), 202);
  }
  return send({ error: 'Method not allowed' }, 405);
}
