import { spawn } from 'node:child_process';

/** Kill descendants too: shells and archive tools can leave a pipe open after their parent exits. */
export function killCommandGroup(child) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

/** A finite, asynchronous command. Output is a bounded tail; streaming consumers see every chunk. */
export function runBounded(
  command,
  args,
  {
    timeoutMs = 8000,
    start = spawn,
    env,
    cwd,
    onOutput,
    onStdout,
    maxOutput = 16 * 1024 * 1024,
    progressMs = 60_000,
    onWaiting,
  } = {},
) {
  return new Promise((resolve) => {
    let stdout = '',
      stderr = '',
      settled = false,
      timedOut = false;
    let timer, progress, killTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearInterval(progress);
      resolve({
        stdout,
        stderr,
        timedOut,
        ...result,
        ...(timedOut
          ? {
              status: null,
              stderr: `${command} ${args[0] ?? ''} did not answer in ${Math.round(timeoutMs / 1000)} s (timed out)`,
            }
          : {}),
      });
    };
    let child;
    try {
      child = start(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        ...(env ? { env } : {}),
        ...(cwd ? { cwd } : {}),
      });
    } catch (error) {
      finish({ status: null, stderr: String(error?.message || error), error });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      killCommandGroup(child);
      // Normally close follows SIGKILL immediately. A broken OS pipe must not hold the caller.
      killTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref?.();
        finish({ status: null });
      }, 1000);
    }, timeoutMs);
    if (onWaiting) progress = setInterval(() => onWaiting(), progressMs);
    child.stdout?.setEncoding('utf8').on('data', (text) => {
      stdout = (stdout + text).slice(-maxOutput);
      onStdout?.(text);
      onOutput?.(text);
    });
    child.stderr?.setEncoding('utf8').on('data', (text) => {
      stderr = (stderr + text).slice(-maxOutput);
      onOutput?.(text);
    });
    child.on('error', (error) => finish({ status: null, stderr: error.message, error }));
    child.on('close', (status) => finish({ status }));
  });
}

export async function runChecked(command, args, options) {
  const result = await runBounded(command, args, options);
  if (result.status !== 0) throw new Error(result.stderr || `${command} ${args[0]} failed`);
  return result.stdout;
}

/** Signing a large SEA can spend minutes waiting for macOS's scanner. */
export function runCodesign(args, { run = runBounded, log = console.error, ...options } = {}) {
  return run('codesign', args, {
    timeoutMs: 10 * 60_000,
    onWaiting: () => log(`Waiting for codesign ${args.join(' ')} (10 minute limit)`),
    ...options,
  });
}

export const DATA_COMMAND_TIMEOUT_MS = 24 * 60 * 60_000;
// A job's Docker queries get more room than the relay pass's 8 s: on the iMac with a busy disk
// `docker buildx version` took over 8 s and a container start over a minute (2026-11-12),
// and failing a release on a slow answer is worse than waiting for it.
const JOB_QUERY_TIMEOUT_MS = 30_000;
const JOB_CHANGE_TIMEOUT_MS = 5 * 60_000;
export function dockerCommandTimeout(args) {
  if (args.includes('--help') || (args[0] === 'buildx' && args[1] === 'version'))
    return JOB_QUERY_TIMEOUT_MS;
  // Foreground run/exec can be migrations or large data copies. Only detached startup is short.
  if (
    ['build', 'pull', 'push', 'save', 'load', 'cp', 'exec'].includes(args[0]) ||
    (args[0] === 'buildx' && args[1] === 'build') ||
    // Only Docker's own flag, right after `run`: a migration's own arguments may contain -d
    // (`run --rm image migrate -d database`) and must keep the long limit.
    (args[0] === 'run' && args[1] !== '-d' && args[1] !== '--detach')
  )
    return DATA_COMMAND_TIMEOUT_MS;
  if (
    ['start', 'stop', 'restart', 'run', 'rm', 'create', 'tag'].includes(args[0]) ||
    (['network', 'volume', 'image'].includes(args[0]) &&
      ['create', 'rm', 'connect', 'disconnect'].includes(args[1]))
  )
    return JOB_CHANGE_TIMEOUT_MS;
  return JOB_QUERY_TIMEOUT_MS;
}
