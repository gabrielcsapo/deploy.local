import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { installWorkerBuild } from './worker-update.mjs';

const receiptPath = (root) => join(root, 'worker-update.json');
export function workerUpdateReceipt(root) {
  try {
    return JSON.parse(readFileSync(receiptPath(root), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function persist(root, receipt) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = receiptPath(root);
  writeFileSync(`${path}.tmp`, JSON.stringify(receipt), { mode: 0o600, flush: true });
  renameSync(`${path}.tmp`, path);
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** The service keeps this original process alive across swaps, including failed startup. */
export async function superviseWorker({
  executable,
  args = ['agent', 'run'],
  root,
  version,
  stableMs = 30_000,
  startupMs = 60_000,
  install = installWorkerBuild,
  download = async (request) => {
    const response = await fetch(request.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error('The verified worker build is unavailable.');
    return Buffer.from(await response.arrayBuffer());
  },
  signal,
}) {
  let child,
    stopping = false,
    bootTimer,
    stableTimer,
    updating = false;
  let receipt = workerUpdateReceipt(root);
  function restore(reason) {
    if (digest(executable) !== receipt.previousDigest) {
      if (
        !existsSync(`${executable}.previous`) ||
        digest(`${executable}.previous`) !== receipt.previousDigest
      )
        throw new Error('Previous worker build is missing; automatic recovery stopped.');
      renameSync(`${executable}.previous`, executable);
    }
    receipt = { ...receipt, state: 'failed', version: receipt.previousVersion, error: reason };
    persist(root, receipt);
  }
  // Never infer success from the installed filename after an executor interruption.
  if (receipt && ['staging', 'starting'].includes(receipt.state))
    restore('Update interrupted before startup was confirmed; restored the previous build.');
  return new Promise((resolve, reject) => {
    const clearTimers = () => {
      clearTimeout(bootTimer);
      clearTimeout(stableTimer);
    };
    const stop = () => {
      stopping = true;
      clearTimers();
      child?.kill('SIGTERM');
      if (!child) resolve();
    };
    signal?.addEventListener('abort', stop, { once: true });
    function fail(error) {
      stopping = true;
      clearTimers();
      child?.kill('SIGTERM');
      reject(error);
    }
    function start() {
      if (stopping) return resolve();
      const token = randomUUID();
      child = spawn(executable, args, {
        env: { ...process.env, DEPLOY_WORKER_CHILD: token },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      let ready = false;
      const expected =
        receipt?.state === 'starting' ? receipt.targetVersion : receipt?.version || version;
      bootTimer = setTimeout(() => child.kill('SIGKILL'), startupMs);
      child.on('error', fail);
      child.on('message', async (message) => {
        if (
          message?.type === 'worker-ready' &&
          message.token === token &&
          message.version === expected &&
          !ready
        ) {
          ready = true;
          clearTimeout(bootTimer);
          if (receipt?.state === 'starting') {
            stableTimer = setTimeout(() => {
              receipt = {
                ...receipt,
                state: 'complete',
                version: expected,
                confirmedAt: Date.now(),
              };
              persist(root, receipt);
            }, stableMs);
          }
        }
        if (
          message?.type !== 'worker-update' ||
          updating ||
          !ready ||
          receipt?.state === 'starting'
        )
          return;
        updating = true;
        const request = message.request;
        try {
          receipt = {
            ...request,
            state: 'staging',
            previousVersion: expected,
            previousDigest: digest(executable),
          };
          persist(root, receipt);
          const bytes = await download(request);
          if (stopping || !child) throw new Error('Worker stopped before installation');
          install({
            path: executable,
            bytes,
            sha256: request.sha256,
            size: request.size,
            version: request.targetVersion,
          });
          receipt.state = 'starting';
          persist(root, receipt);
          child.kill('SIGTERM');
        } catch (error) {
          try {
            if (receipt?.state === 'staging') restore(String(error.message || error));
            else {
              receipt = {
                ...request,
                state: 'failed',
                version: expected,
                error: String(error.message || error),
              };
              persist(root, receipt);
            }
          } catch (restoreError) {
            return fail(restoreError);
          }
        } finally {
          updating = false;
        }
      });
      child.on('exit', () => {
        clearTimers();
        child = null;
        if (stopping) return resolve();
        try {
          // A requested exit of the old process begins the candidate's first startup.
          if (receipt?.state === 'starting' && expected === receipt.targetVersion)
            restore(
              'The replacement failed its sustained startup check; restored the previous build.',
            );
          setTimeout(start, 250);
        } catch (error) {
          fail(error);
        }
      });
    }
    if (signal?.aborted) stop();
    else start();
  });
}
