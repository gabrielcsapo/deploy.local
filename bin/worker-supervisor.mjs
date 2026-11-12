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
import { superviseRelays } from './relay-supervisor.mjs';
import { RELAY_PROTOCOL } from './relay-process.mjs';

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
  // The embedded CLI enables relays using its stable supervisor executable.
  relay,
  root,
  version,
  stableMs = 30_000,
  startupMs = 60_000,
  heartbeatMs = 120_000,
  watchdogIntervalMs = 10_000,
  killGraceMs = 10_000,
  log = console.error,
  install = installWorkerBuild,
  download = async (request) => {
    const response = await fetch(request.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error('The verified worker build is unavailable.');
    return Buffer.from(await response.arrayBuffer());
  },
  signal,
  // Runs once the replacement passed its sustained startup check, e.g. to restart the task worker.
  onUpdated = () => {},
  // Where the replaced build waits for a rollback (outside a macOS app bundle's seal).
  previous = `${executable}.previous`,
  // Runs after a new build is swapped in or the previous one restored, before any child starts:
  // macOS re-seals the worker app here. Sealing rewrites the signature bytes, so `previousDigest`
  // is always taken from the sealed build an update replaces, and `previous` keeps those bytes.
  afterInstall = () => {},
}) {
  let child,
    stopping = false,
    bootTimer,
    stableTimer,
    updating = false,
    updateTask,
    watchdogTimer,
    killTimer,
    restartTimer;
  let receipt = workerUpdateReceipt(root);
  async function restore(reason, reseal = true) {
    let restored = false;
    if (digest(executable) !== receipt.previousDigest) {
      if (!existsSync(previous) || digest(previous) !== receipt.previousDigest)
        throw new Error('Previous worker build is missing; automatic recovery stopped.');
      renameSync(previous, executable);
      restored = true;
    }
    receipt = { ...receipt, state: 'failed', version: receipt.previousVersion, error: reason };
    // Record the rollback before sealing: the seal changes the bytes the digest check compares.
    persist(root, receipt);
    // If staging/signing failed before the swap, the old sealed binary is untouched.
    if (restored && reseal) await afterInstall(executable);
  }

  // Never infer success from the installed filename after an executor interruption.
  if (receipt && ['staging', 'starting'].includes(receipt.state))
    await restore('Update interrupted before startup was confirmed; restored the previous build.');
  const relays = relay ? superviseRelays({ ...relay, log }) : null;
  if (!signal?.aborted) await relays?.start();
  return new Promise((resolve, reject) => {
    const finish = async (error) => {
      await relays?.stop();
      signal?.removeEventListener('abort', stop);
      if (error) reject(error);
      else resolve();
    };
    const clearTimers = () => {
      clearTimeout(bootTimer);
      clearTimeout(stableTimer);
      clearInterval(watchdogTimer);
      clearTimeout(killTimer);
      clearTimeout(restartTimer);
    };
    const stop = () => {
      stopping = true;
      clearTimers();
      terminate(child);
      if (!child && !updating) void finish();
    };
    signal?.addEventListener('abort', stop, { once: true });
    function fail(error) {
      stopping = true;
      clearTimers();
      terminate(child);
      void finish(error);
    }
    function terminate(target) {
      if (!target) return;
      target.kill('SIGTERM');
      killTimer = setTimeout(() => target.kill('SIGKILL'), killGraceMs);
    }
    function start() {
      if (stopping) return void finish();
      const token = randomUUID();
      child = spawn(executable, args, {
        env: {
          ...process.env,
          DEPLOY_WORKER_CHILD: token,
          DEPLOY_RELAY_PROTOCOL: relays ? String(RELAY_PROTOCOL) : '',
        },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      const current = child;
      let ready = false,
        lastHeartbeat = Date.now(),
        terminating = false;
      const expected =
        receipt?.state === 'starting' ? receipt.targetVersion : receipt?.version || version;
      bootTimer = setTimeout(() => current.kill('SIGKILL'), startupMs);
      watchdogTimer = setInterval(() => {
        if (!ready || updating || terminating || stopping) return;
        if (Date.now() - lastHeartbeat <= heartbeatMs) return;
        terminating = true;
        log(
          `Worker ${current.pid} heartbeat stopped for ${Math.round(heartbeatMs / 1000)} s; restarting`,
        );
        terminate(current);
      }, watchdogIntervalMs);
      child.on('error', fail);
      child.on('message', (message) => {
        void relays?.handle(message, current).catch(fail);
        if (message?.type === 'worker-heartbeat' && message.token === token && ready)
          lastHeartbeat = Date.now();
        if (
          message?.type === 'worker-ready' &&
          message.token === token &&
          message.version === expected &&
          !ready
        ) {
          ready = true;
          lastHeartbeat = Date.now();
          clearTimeout(bootTimer);
          if (receipt?.state === 'starting') {
            stableTimer = setTimeout(async () => {
              receipt = {
                ...receipt,
                state: 'complete',
                version: expected,
                confirmedAt: Date.now(),
              };
              persist(root, receipt);
              try {
                await onUpdated(receipt);
              } catch (error) {
                console.error(`Worker updated, but ${error.message || error}`);
              }
            }, stableMs);
          }
        }
        if (
          message?.type !== 'worker-update' ||
          terminating ||
          stopping ||
          updating ||
          !ready ||
          receipt?.state === 'starting'
        )
          return;
        updating = true;
        const request = message.request;
        updateTask = (async () => {
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
            await install({
              path: executable,
              bytes,
              sha256: request.sha256,
              size: request.size,
              version: request.targetVersion,
              previous,
            });
            await afterInstall(executable);
            if (stopping || child !== current)
              throw new Error('Worker stopped during installation');
            receipt.state = 'starting';
            persist(root, receipt);
            terminating = true;
            terminate(current);
          } catch (error) {
            log(`Worker update abandoned: ${error.message || error}`);
            try {
              if (receipt?.state === 'staging')
                await restore(String(error.message || error), !error.workerBundleRestored);
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
            lastHeartbeat = Date.now();
          }
        })();
      });
      child.on('exit', async () => {
        clearTimers();
        child = null;
        // Installation and rollback own the executable until their async work completes.
        await updateTask;
        if (stopping) return void finish();
        try {
          await relays?.workerExited(current);
          // A requested exit of the old process begins the candidate's first startup.
          if (receipt?.state === 'starting' && expected === receipt.targetVersion)
            await restore(
              'The replacement failed its sustained startup check; restored the previous build.',
            );
          restartTimer = setTimeout(start, 250);
        } catch (error) {
          fail(error);
        }
      });
    }
    if (signal?.aborted) stop();
    else start();
  });
}
