import { spawn } from 'node:child_process';

/**
 * Run a command without stopping the worker while it runs. The worker forwards app traffic and
 * sends heartbeats from one thread, so a Docker daemon that hangs must cost it nothing but this
 * one answer. The result has spawnSync's shape; a command that outlives its time is killed and
 * reports status null with `timedOut`.
 */
export function runBounded(command, args, { timeoutMs = 8000, start = spawn } = {}) {
  return new Promise((resolve) => {
    let stdout = '',
      stderr = '',
      settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut: false, ...result });
    };
    let child;
    try {
      child = start(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      return resolve({ status: null, stdout, stderr: String(error?.message || error), error });
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish({
        status: null,
        timedOut: true,
        stderr: `${command} ${args[0] ?? ''} did not answer in ${Math.round(timeoutMs / 1000)} s`,
      });
    }, timeoutMs);
    child.stdout?.setEncoding('utf8').on('data', (text) => (stdout += text));
    child.stderr?.setEncoding('utf8').on('data', (text) => (stderr += text));
    child.on('error', (error) => finish({ status: null, stderr: error.message, error }));
    child.on('close', (status) => finish({ status }));
  });
}
