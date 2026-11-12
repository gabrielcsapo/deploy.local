import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { RELAY_PROTOCOL } from './relay-process.mjs';

/** Separate lifecycle: worker restarts never touch this child or its backoff timer. */
export function superviseRelays({
  executable,
  args = ['agent', 'relay'],
  path,
  startupMs = 5_000,
  retryMs = 250,
  maxRetryMs = 5_000,
  killGraceMs = 1_000,
  log = console.error,
}) {
  let child,
    ready = false,
    stopped = false,
    fallback = false;
  let starting,
    retryTimer,
    scheduled,
    cancelRetry,
    readyAt,
    backoff = retryMs;
  const pending = new Map();
  const handles = new Map();
  const exited = new WeakSet();
  function clearRetry() {
    clearTimeout(retryTimer);
    scheduled = null;
    cancelRetry?.(false);
    cancelRetry = null;
  }
  const send = (target, message) => {
    if (target?.connected) target.send(message, () => {});
  };
  async function kill() {
    const current = child;
    if (!current) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => current.kill('SIGKILL'), killGraceMs);
      current.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      current.kill('SIGTERM');
    });
  }
  function start() {
    if (stopped || fallback) return Promise.resolve(false);
    if (ready) return Promise.resolve(true);
    if (starting) return starting;
    if (scheduled) return scheduled;
    starting = new Promise((resolve) => {
      const current = spawn(executable, args, {
        env: { ...process.env, DEPLOY_RELAY_STATE: path, DEPLOY_RELAY_CHILD: '1' },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      child = current;
      const timer = setTimeout(() => current.kill('SIGKILL'), startupMs);
      current.on('error', (error) => log(`Relay process could not start: ${error.message}`));
      current.on('message', (message) => {
        if (message?.type === 'relay-ready' && message.protocol === RELAY_PROTOCOL) {
          clearTimeout(timer);
          ready = true;
          readyAt = Date.now();
          resolve(true);
        }
        if (message?.type === 'relay-result') {
          const entry = pending.get(message.id);
          if (!entry) return;
          pending.delete(message.id);
          clearTimeout(entry.timer);
          entry.resolve(message);
        }
      });
      current.once('close', () => {
        clearTimeout(timer);
        child = null;
        ready = false;
        starting = null;
        for (const entry of pending.values()) {
          clearTimeout(entry.timer);
          entry.resolve(null);
        }
        pending.clear();
        resolve(false);
        if (!stopped && !fallback) {
          log(`Relay process exited; restarting in ${backoff} ms`);
          scheduled = new Promise((resolveRetry) => {
            cancelRetry = resolveRetry;
            retryTimer = setTimeout(() => {
              scheduled = null;
              cancelRetry = null;
              resolveRetry(start());
            }, backoff);
          });
          backoff = Math.min(maxRetryMs, backoff * 2);
        }
      });
    });
    return starting;
  }
  async function request() {
    if (!(await start())) return null;
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, startupMs);
      pending.set(id, { resolve, timer });
      send(child, { type: 'relay-sync', protocol: RELAY_PROTOCOL, id });
    });
  }
  async function handle(message, worker) {
    let result = await request();
    // A crash during a request is recoverable: replay the desired file after a restart.
    if (!result && !stopped && !fallback && !exited.has(worker)) result = await request();
    if (stopped || exited.has(worker)) return;
    if (!result) {
      // Grant in-process ownership only after all remote listeners are gone. Suspend retries
      // while this worker owns sockets; its next replacement can try the relay process again.
      fallback = true;
      clearRetry();
      await kill();
      result = { unavailable: true };
    } else if (Date.now() - readyAt >= 30_000) backoff = retryMs;
    if (!exited.has(worker)) send(worker, { ...result, type: 'relay-result', id: message.id });
  }
  return {
    start,
    handle(message, worker) {
      if (message?.type !== 'relay-sync' || message.protocol !== RELAY_PROTOCOL)
        return Promise.resolve();
      const tasks = handles.get(worker) || new Set();
      handles.set(worker, tasks);
      const task = handle(message, worker);
      tasks.add(task);
      return task.finally(() => {
        tasks.delete(task);
        if (!tasks.size) handles.delete(worker);
      });
    },
    async workerExited(worker) {
      exited.add(worker);
      await Promise.all(handles.get(worker) || []);
      if (fallback) {
        fallback = false;
        await start();
      }
    },
    async stop() {
      stopped = true;
      clearRetry();
      await kill();
    },
  };
}
