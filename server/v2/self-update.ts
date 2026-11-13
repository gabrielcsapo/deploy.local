import { sendJson } from '../http.ts';
import { CopyWarmer } from '../packages/copies.ts';
import { npmRegistry } from '../packages/npm.ts';
import { computerInstallConfig } from '../packages/builds.ts';
import {
  writeFile as writePrivateFile,
  chown as chownPrivateFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { processResult } from '../process.ts';
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
import type { SelfUpdateRun, SelfUpdateStatus } from '../../shared/v2/contracts.ts';
import { isAdmin, getSqlite } from '../store.ts';
import { list } from '../workspace/store.ts';
import {
  changesSince,
  findSourceRepository,
  readReleaseConfig,
  runningRevision,
  type ReleaseConfig,
} from './self-update-host.ts';
import { fail } from '../errors.ts';
import { getComputers } from './computers.ts';

export {
  changesSince,
  findSourceRepository,
  readReleaseConfig,
  runningRevision,
} from './self-update-host.ts';
import { dispatch, routes } from '../routes.ts';
const DEFAULT_ESTIMATE_MS = 6 * 60_000;
const STARTUP_GRACE_MS = 20_000;

const stateDirectory = (config: ReleaseConfig) => join(dirname(config.current), 'self-update');
const stateFile = (config: ReleaseConfig) => join(stateDirectory(config), 'current.json');
const readJson = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
};
const unitName = (id: string) => `deploy-self-update-${id.slice(0, 8)}`;
async function unitActive(id: string) {
  return (await processResult('systemctl', ['is-active', '--quiet', unitName(id)])).status === 0;
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
async function context(owner: string): Promise<Context> {
  if (!isAdmin(owner)) return { reason: 'Only an administrator can update deploy.local.' };
  const config = readReleaseConfig();
  if (!config) return { reason: 'This computer was not set up with deploy-update.' };
  const running = runningRevision(config);
  if (!running) return { reason: 'The running release has no verified revision.' };
  const repository = await findSourceRepository(
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
export async function selfUpdateStatus(owner: string): Promise<SelfUpdateStatus> {
  const found = await context(owner);
  if ('reason' in found) return { supported: false, reason: found.reason };
  const { config, running, repository } = found;
  const directory = stateDirectory(config);
  const computer = getComputers(owner).find((c) => c.roles.includes('coordinator'))?.name || 'SER';
  const changes = await changesSince(repository.path, running);
  const run = withoutPlan(readJson<SelfUpdateRun>(stateFile(config)));
  const checkedAt = Date.now();
  const active =
    run?.state === 'running' && checkedAt - Date.parse(run.startedAt) >= STARTUP_GRACE_MS
      ? await unitActive(run.id)
      : true;
  return {
    supported: true,
    computer,
    running,
    ...changes,
    run: settleRun(run, running, () => active, checkedAt),
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

/** Reserve before any asynchronous preparation and release even on validation/write failure. */
export function selfUpdateStarter<T>(start: (owner: string, to: unknown) => Promise<T>) {
  let starting = false;
  return async (owner: string, to: unknown): Promise<T> => {
    if (starting) fail('An update is already running.', 409);
    starting = true;
    try {
      return await start(owner, to);
    } finally {
      starting = false;
    }
  };
}
export async function boundedScan(scan: Promise<unknown>, timeoutMs = 3000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      scan.catch(() => {}),
      new Promise<void>((done) => {
        timer = setTimeout(done, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export const startSelfUpdate = selfUpdateStarter(performSelfUpdate);
async function performSelfUpdate(owner: string, to: unknown): Promise<SelfUpdateStatus> {
  const found = await context(owner);
  if ('reason' in found) fail(found.reason, 409);
  const { config, running, repository } = found;
  const status = await selfUpdateStatus(owner);
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
  // No live updater remains (checked above). Remove secrets left by a crash before provisioning.
  for (const name of await readdir(directory))
    if (name.startsWith('package-install-') || name.endsWith('.packages.json'))
      await rm(join(directory, name), { recursive: true, force: true });
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
  // Only a path enters the public run. The key stays outside every release directory.
  const packageConfig = join(directory, `${id}.packages.json`);
  const project = list('project', owner).find((p) => p.repositoryPath === repository.path);
  if (project) {
    run.plan.packageProject = project.id;
    const warmer = new CopyWarmer(npmRegistry.copy);
    await boundedScan(
      Promise.all(
        [run.from, run.to].map((commit) =>
          warmer.scan(owner, project, commit, commit, 'self-release', false),
        ),
      ),
    );
    getSqlite()!
      .prepare("INSERT OR REPLACE INTO system_settings VALUES('packages.selfUpdateContext',?,?)")
      .run(
        JSON.stringify({
          owner,
          projectId: project.id,
          from: run.from,
          to: run.to,
          state: 'running',
        }),
        new Date().toISOString(),
      );
  }
  try {
    const install = await computerInstallConfig(owner, 'local', project?.id);
    if (install) {
      await writePrivateFile(packageConfig, JSON.stringify(install), { mode: 0o600, flag: 'wx' });
      await chownPrivateFile(packageConfig, uid, gid);
      run.plan.packageConfig = packageConfig;
    }
    const file = stateFile(config);
    writeFileSync(`${file}.tmp`, JSON.stringify(run, null, 2), { mode: 0o644 });
    chownSync(`${file}.tmp`, uid, gid);
    renameSync(`${file}.tmp`, file);
    // A transient unit of its own: restarting deploy-server.service must not stop the updater.
    const result = await processResult(
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
      {},
    );
    if (result.status !== 0) {
      await rm(packageConfig, { force: true });
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
  } catch (error) {
    await rm(packageConfig, { force: true });
    throw error;
  }
}

export async function selfUpdateLog(owner: string) {
  const found = await context(owner);
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

const route = routes<string>();

const methodNotAllowed = ({ res }: { res: ServerResponse }) =>
  sendJson(res, { error: 'Method not allowed' }, 405);

export const selfUpdateRoutes = [
  route({
    method: 'GET',
    path: '/self-update/log',
    handler: async ({ res, context: owner }) => sendJson(res, await selfUpdateLog(owner)),
  }),
  route({
    method: 'GET',
    path: '/self-update',
    handler: async ({ res, context: owner }) => sendJson(res, await selfUpdateStatus(owner)),
  }),
  route({
    method: 'POST',
    path: '/self-update',
    handler: async ({ req, res, context: owner }) => startSelfUpdateRoute(req, res, owner),
  }),
  route({ method: '*', path: '/self-update/log', handler: methodNotAllowed }),
  route({ method: '*', path: '/self-update', handler: methodNotAllowed }),
];

// These paths are matched without their /api/v2 prefix, as they always were.
const selfUpdateDispatch = dispatch(selfUpdateRoutes, {
  path: (url) => url.pathname.slice('/api/v2'.length),
});

export async function selfUpdateApi(req: IncomingMessage, res: ServerResponse, owner: string) {
  return selfUpdateDispatch(req, res, owner);
}

async function startSelfUpdateRoute(req: IncomingMessage, res: ServerResponse, owner: string) {
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
  return sendJson(res, await startSelfUpdate(owner, input.to), 202);
}
