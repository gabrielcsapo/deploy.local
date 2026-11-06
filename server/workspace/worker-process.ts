import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { isSea } from 'node:sea';
import { workerBuild, type WorkerBuild } from './worker-build.ts';

export type WorkerLease = {
  pid: number;
  executablePath: string;
  entryPath: string;
  workerRoot?: string;
  build: WorkerBuild;
  started?: string;
};
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);

/** Linux refuses this read while a process exits or belongs to another user: unverified, not fatal. */
function readWorkerRoot(pid: number) {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8')
      .split('\0')
      .find((entry) => entry.startsWith('DEPLOY_WORKER_ROOT='))
      ?.slice('DEPLOY_WORKER_ROOT='.length);
  } catch (error: any) {
    if (error.code === 'EACCES') return undefined;
    throw error;
  }
}

/** A start token prevents a recycled PID from authorizing a signal to another process. */
function inspect(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid worker PID');
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ');
      if (fields[0] === 'Z') return null;
      return {
        started: fields[19],
        executablePath: readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, ''),
        args: readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean),
        // Inspect only the scope marker; never log the process environment or credentials.
        workerRoot: readWorkerRoot(pid),
      };
    }
    // Platforms without a start-token probe can respect live locks, but cannot signal them.
    if (process.platform !== 'darwin') return { started: undefined, command: '' };
    const result = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'lstart=,stat=,command='], {
      encoding: 'utf8',
    }).trim();
    const match = result.match(/^(.{24})\s+(\S+)\s+(.*)$/);
    if (!match) throw new Error('Could not verify worker process identity');
    if (match[2].startsWith('Z')) return null;
    return { started: match[1], command: match[3] };
  } catch (error: any) {
    if (error.code === 'ESRCH' || error.code === 'ENOENT') return null;
    // ps may lose a process between kill(0) and its own read. Confirm death explicitly.
    if (error.status === 1) {
      try {
        process.kill(pid, 0);
      } catch (probe: any) {
        if (probe.code === 'ESRCH') return null;
      }
    }
    throw error;
  }
}

export function workerLease(build = workerBuild): WorkerLease {
  return {
    pid: process.pid,
    executablePath: process.execPath,
    entryPath: isSea() ? process.execPath : resolve(process.argv[1] || process.execPath),
    build,
    started: inspect(process.pid)?.started,
  };
}

/** Legacy numeric leases are readable, but never justify killing an unidentified PID. */
export function stopStaleWorker(prior: WorkerLease | number, current: WorkerLease) {
  const pid = typeof prior === 'number' ? prior : prior.pid;
  const live = inspect(pid);
  if (!live) return;
  const alreadyRunning = () => {
    throw new Error(
      `Worker already running (${pid}); its identity must be verified before takeover`,
    );
  };
  if (pid === process.pid) return alreadyRunning();
  if (typeof prior === 'number') {
    // Old AppImages wrote only a PID. Recover only when /proc proves this is the remote
    // worker from another install. A shared node executable alone proves nothing.
    if (
      !live.args ||
      !current.workerRoot ||
      !live.workerRoot ||
      resolve(live.workerRoot) !== current.workerRoot
    )
      return alreadyRunning();
    const entry = live.args.find((arg) => /(?:^|\/)workspace-remote-worker\.(?:js|ts)$/.test(arg));
    if (!entry || (entry === current.entryPath && live.executablePath === current.executablePath))
      return alreadyRunning();
  } else {
    if (!prior.started) return alreadyRunning();
    if (prior.started !== live.started) return; // PID was reused; the lease holder is gone.
    if (live.args) {
      if (live.executablePath !== prior.executablePath || !live.args.includes(prior.entryPath))
        return alreadyRunning();
    } else if (!live.command.includes(prior.entryPath)) return alreadyRunning();
    if (
      prior.executablePath === current.executablePath &&
      prior.entryPath === current.entryPath &&
      prior.build.version === current.build.version &&
      prior.build.commit === current.build.commit
    )
      return alreadyRunning();
  }
  // Recheck the start token before each signal; never signal a reused PID or its group.
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (inspect(pid)?.started !== live.started) return;
    try {
      process.kill(pid, signal);
    } catch (error: any) {
      if (error.code !== 'ESRCH') throw error;
    }
    const deadline = Date.now() + (signal === 'SIGTERM' ? 3000 : 1000);
    while (Date.now() < deadline) {
      if (inspect(pid)?.started !== live.started) return;
      pause();
    }
  }
  throw new Error(`Stale worker ${pid} did not stop; refusing a second owner`);
}

/** Only app-owned workers opt in. launchd and standalone SEA workers can have PID 1 parents. */
export function watchWorkerParent(
  shutdown: () => void,
  parent = process.env.DEPLOY_WORKER_PARENT_PID,
) {
  process.on('disconnect', shutdown);
  let timer: ReturnType<typeof setInterval> | undefined;
  if (parent) {
    const pid = Number(parent);
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid worker parent PID');
    const check = () => {
      if (process.ppid !== pid || process.connected === false) shutdown();
    };
    timer = setInterval(check, 500);
    timer.unref();
    check();
  }
  return () => {
    clearInterval(timer);
    process.off('disconnect', shutdown);
  };
}
