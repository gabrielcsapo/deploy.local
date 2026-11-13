import {
  copyFileSync,
  chmodSync,
  existsSync,
  linkSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { release } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson, bundleDigest } from './code-bundle.mjs';
import { runBounded } from './bounded-command.mjs';
import { workerBuildInfo } from './worker-update.mjs';
import {
  sealWorkerBundle,
  WORKER_APP_ID,
  workerExecutablePaths,
  restartWorkerService,
} from './agent-services.mjs';

export const SUPERVISOR_STARTUP_MS = 300_000;
const SIGN_MS = 10 * 60_000;
export const launcherCapable = (info) =>
  Number.isSafeInteger((info?.executable || info)?.launcherProtocol) &&
  (info.executable || info).launcherProtocol > 0;
const executableInfo = (info) => info.executable || info;
const targetKey = (info) => `${info.version}:${info.commit || ''}:${info.launcherProtocol}`;
const recordPath = (root) => join(root, 'supervisor-swap.json');
export function supervisorSwapReceipt(root) {
  try {
    const receipt = JSON.parse(readFileSync(recordPath(root), 'utf8'));
    // A manager can accept the helper but fail to execute it. Do not hold job admission forever.
    if (receipt.state === 'queued' && Date.now() - receipt.at > SUPERVISOR_STARTUP_MS) {
      const failed = {
        ...receipt,
        state: 'failed',
        error: 'Supervisor swap helper did not start within the startup window',
      };
      atomicJson(recordPath(root), failed);
      return failed;
    }
    return receipt;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
const checked = (result) => {
  if (result.status !== 0) throw new Error(result.stderr || 'Supervisor service command failed');
  return result;
};
export async function restartAgentService({
  platform = process.platform,
  uid = process.getuid?.(),
  run = runBounded,
} = {}) {
  checked(
    platform === 'darwin'
      ? await run('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/sh.deploy.agent`], {
          timeoutMs: 15000,
        })
      : await run(
          'systemctl',
          [...(uid === 0 ? [] : ['--user']), 'restart', 'deploy-local-agent.service'],
          { timeoutMs: 15000 },
        ),
  );
}
export async function waitForSupervisor({
  root,
  since,
  targetVersion,
  startupMs = SUPERVISOR_STARTUP_MS,
  sleep = delay,
}) {
  const deadline = Date.now() + startupMs;
  do {
    try {
      const ready = JSON.parse(readFileSync(join(root, 'supervisor-ready.json'), 'utf8'));
      if (
        ready.at >= since &&
        ready.executableVersion === targetVersion &&
        ready.launcherProtocol > 0
      )
        return;
    } catch {}
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error('Replacement supervisor did not report ready within the startup window');
}

/** Shared by the out-of-service helper and the desktop's explicitly requested Repair. */
export async function swapSupervisor({
  agentDir,
  root = join(agentDir, 'data'),
  paths = workerExecutablePaths(agentDir),
  platform = process.platform,
  darwinRelease = release(),
  busy = false,
  explicit = false,
  scheduled = false,
  readBuildInfo = workerBuildInfo,
  run = runBounded,
  seal = (app) =>
    sealWorkerBundle(app, {
      // Ten minutes, like every other signing step: on a busy Intel iMac signing took minutes,
      // and a swap that times out is not tried again for the same build.
      run: (command, args, options) => run(command, args, { ...options, timeoutMs: SIGN_MS }),
      signSupervisor: false,
    }),
  restart = () => restartAgentService({ platform, run }),
  waitReady = (options) => waitForSupervisor(options),
}) {
  if (busy || !['darwin', 'linux'].includes(platform)) return { state: 'skipped' };
  const prior = supervisorSwapReceipt(root);
  const previous = `${paths.supervisor}.previous`;
  // The service manager retries an interrupted helper. Continue by rolling back, never by
  // attempting the target a second time (including a crash between rename and its receipt).
  if (scheduled && ['staging', 'starting'].includes(prior?.state)) {
    let recoveryError;
    try {
      if (
        existsSync(paths.supervisor) &&
        bundleDigest(readFileSync(paths.supervisor)) !== prior.previousDigest
      ) {
        if (!existsSync(previous) || bundleDigest(readFileSync(previous)) !== prior.previousDigest)
          throw new Error('Previous supervisor is unavailable for recovery');
        renameSync(previous, paths.supervisor);
        if (paths.app) await seal(paths.app);
        await restart();
      }
    } catch (error) {
      recoveryError = String(error.message || error);
    }
    const failed = {
      ...prior,
      state: 'failed',
      error: 'Supervisor swap interrupted before startup confirmation',
      ...(recoveryError ? { recoveryError } : {}),
    };
    atomicJson(recordPath(root), failed);
    return failed;
  }
  const installed = await readBuildInfo(paths.supervisor).catch(() => null);
  if (launcherCapable(installed)) return { state: 'current' };
  const target = executableInfo(await readBuildInfo(paths.executable));
  if (!launcherCapable(target)) return { state: 'unavailable' };
  const key = targetKey(target);
  if (platform === 'darwin' && Number(darwinRelease.split('.')[0]) >= 24 && !explicit) {
    const receipt = { ...prior, state: 'needs-repair', target: key, targetVersion: target.version };
    atomicJson(recordPath(root), receipt);
    return receipt;
  }
  if (
    prior?.attempts?.includes(key) &&
    !(scheduled && prior.state === 'queued' && prior.target === key)
  )
    return prior;
  let receipt = {
    ...prior,
    state: 'staging',
    previousDigest: existsSync(paths.supervisor)
      ? bundleDigest(readFileSync(paths.supervisor))
      : null,
    target: key,
    targetVersion: target.version,
    attempts: [...new Set([...(prior?.attempts || []), key])],
    at: Date.now(),
  };
  const persist = (fields) => {
    receipt = { ...receipt, ...fields };
    atomicJson(recordPath(root), receipt);
  };
  persist({});
  const staged = `${paths.supervisor}.stage-${process.pid}`;
  let swapped = false;
  const hadSupervisor = existsSync(paths.supervisor);
  try {
    copyFileSync(paths.executable, staged);
    chmodSync(staged, 0o755);
    if (platform === 'darwin')
      checked(
        await run(
          '/usr/bin/codesign',
          ['--force', '--sign', '-', '--identifier', WORKER_APP_ID, staged],
          { timeoutMs: SIGN_MS },
        ),
      );
    // Assess the final signed inode BEFORE rename; macOS's assessment cache follows the inode.
    const assessed = executableInfo(await readBuildInfo(staged));
    if (!launcherCapable(assessed) || targetKey(assessed) !== key)
      throw new Error('Staged supervisor does not match the launcher build');
    if (hadSupervisor) {
      rmSync(previous, { force: true });
      linkSync(paths.supervisor, previous);
    }
    renameSync(staged, paths.supervisor);
    swapped = true;
    persist({ state: 'starting' });
    if (paths.app) await seal(paths.app);
    const since = Date.now();
    await restart();
    await waitReady({ root, since, targetVersion: target.version });
    persist({ state: 'complete', confirmedAt: Date.now() });
    return receipt;
  } catch (error) {
    if (swapped) {
      if (hadSupervisor) renameSync(previous, paths.supervisor);
      else rmSync(paths.supervisor, { force: true });
      try {
        if (paths.app) await seal(paths.app);
        await restart();
      } catch (recovery) {
        persist({ recoveryError: String(recovery.message || recovery) });
      }
    }
    persist({ state: 'failed', error: String(error.message || error) });
    throw error;
  } finally {
    rmSync(staged, { force: true });
  }
}

/** A separate service survives launchd kickstart and systemd's control-group termination. */
export async function scheduleSupervisorSwap({
  agentDir,
  configPath = process.env.DEPLOY_AGENT_CONFIG || join(agentDir, 'agent.json'),
  root = join(agentDir, 'data'),
  paths = workerExecutablePaths(agentDir),
  platform = process.platform,
  darwinRelease = release(),
  uid = process.getuid?.(),
  busy = false,
  readBuildInfo = workerBuildInfo,
  run = runBounded,
  reserve = async () => true,
}) {
  if (busy || !['darwin', 'linux'].includes(platform)) return false;
  if (launcherCapable(await readBuildInfo(paths.supervisor).catch(() => null))) return false;
  const target = executableInfo(await readBuildInfo(paths.executable));
  if (!launcherCapable(target)) return false;
  if (platform === 'darwin' && Number(darwinRelease.split('.')[0]) >= 24) {
    await swapSupervisor({ agentDir, root, paths, platform, darwinRelease, readBuildInfo });
    return false;
  }
  const key = targetKey(target),
    prior = supervisorSwapReceipt(root);
  if (prior?.attempts?.includes(key)) return false;
  if (!(await reserve(key))) return false;
  const receipt = {
    ...prior,
    state: 'queued',
    target: key,
    targetVersion: target.version,
    attempts: [...(prior?.attempts || []), key],
    at: Date.now(),
  };
  atomicJson(recordPath(root), receipt);
  const env = {
    DEPLOY_AGENT_CONFIG: configPath,
    DEPLOY_DATA_DIR: root,
    DEPLOY_WORKER_CHILD: '',
    // The helper removes its own one-off launchd job when it is done; a submitted job
    // otherwise stays listed for ever.
    ...(platform === 'darwin'
      ? { DEPLOY_SWAP_JOB: `sh.deploy.supervisor-swap.${process.pid}` }
      : {}),
    ...(paths.app ? { DEPLOY_WORKER_APP: paths.app } : {}),
    ...Object.fromEntries(
      ['DEPLOY_WORKER_ROOT', 'NODE_EXTRA_CA_CERTS', 'DEPLOY_MDNS_ADDRESS']
        .filter((name) => process.env[name])
        .map((name) => [name, process.env[name]]),
    ),
  };
  const assignments = Object.entries(env).map(([name, value]) => `${name}=${value}`);
  try {
    checked(
      platform === 'darwin'
        ? await run(
            '/bin/launchctl',
            [
              'submit',
              '-l',
              `sh.deploy.supervisor-swap.${process.pid}`,
              '--',
              '/usr/bin/env',
              ...assignments,
              paths.executable,
              'agent',
              'supervisor-swap',
            ],
            { timeoutMs: 15000 },
          )
        : await run(
            'systemd-run',
            [
              ...(uid === 0 ? [] : ['--user']),
              '--collect',
              '--property=Restart=on-failure',
              '--property=RestartSec=1s',
              `--unit=deploy-local-supervisor-swap-${process.pid}`,
              ...assignments.map((value) => `--setenv=${value}`),
              paths.executable,
              'agent',
              'supervisor-swap',
            ],
            { timeoutMs: 15000 },
          ),
    );
    return true;
  } catch (error) {
    atomicJson(recordPath(root), {
      ...receipt,
      state: 'failed',
      error: String(error.message || error),
    });
    throw error;
  }
}

export async function restartUpdatedServices(
  receipt,
  { restartTasks = restartWorkerService, restartSupervisor = restartAgentService } = {},
) {
  try {
    await restartTasks();
  } finally {
    // This drops relays briefly. Opt in only for supervisor fixes, never routine code updates.
    if (receipt.kind === 'code' && receipt.restartSupervisor === true) await restartSupervisor();
  }
}
