import net from 'node:net';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const locks = new Set();
const listen = net.Server.prototype.listen;
const close = net.Server.prototype.close;
const releases = new WeakMap();
net.Server.prototype.close = function (...args) {
  const result = close.apply(this, args);
  releases.get(this)?.();
  return result;
};
const spawnSync = childProcess.spawnSync;
// Only two assigned ports: serialize test files while keeping the root pnpm test command.
childProcess.spawnSync = (command, args, options) =>
  spawnSync(
    command,
    args?.map((arg) => (arg === '--test-concurrency=4' ? '--test-concurrency=1' : arg)),
    options,
  );
syncBuiltinESMExports();
net.Server.prototype.listen = function (...args) {
  const first = args[0];
  const numeric = typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first));
  const port = numeric
    ? Number(first)
    : first && typeof first === 'object'
      ? Number(first.port)
      : NaN;
  if (port === 0) {
    let chosen;
    for (const candidate of [5184, 5185]) {
      if (
        spawnSync('lsof', ['-nP', `-iTCP:${candidate}`, '-sTCP:LISTEN'], {
          encoding: 'utf8',
        }).stdout?.trim()
      )
        continue;
      const path = join(process.env.DEPLOY_DESKTOP_TEST_GUARD_DIR, String(candidate));
      try {
        mkdirSync(path);
        chosen = { port: candidate, path };
        locks.add(path);
        break;
      } catch {}
    }
    if (!chosen) {
      queueMicrotask(() =>
        this.emit(
          'error',
          Object.assign(new Error('Both desktop test ports are busy'), { code: 'EADDRINUSE' }),
        ),
      );
      return this;
    }
    if (numeric) args[0] = chosen.port;
    else args[0] = { ...first, port: chosen.port };
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      locks.delete(chosen.path);
      rmSync(chosen.path, { recursive: true, force: true });
    };
    releases.set(this, release);
    this.once('close', release);
    this.once('error', release);
  } else if (Number.isFinite(port) && ![5184, 5185].includes(port)) {
    queueMicrotask(() =>
      this.emit(
        'error',
        Object.assign(new Error(`Test port outside assigned 5184/5185: ${port}`), {
          code: port >= 5180 && port <= 5199 ? 'EADDRINUSE' : 'EACCES',
        }),
      ),
    );
    return this;
  }
  return listen.apply(this, args);
};
dgram.Socket.prototype.bind = function () {
  queueMicrotask(() =>
    this.emit(
      'error',
      Object.assign(new Error('mDNS disabled in desktop test run'), { code: 'EACCES' }),
    ),
  );
  return this;
};
process.on('exit', () => {
  for (const path of locks) rmSync(path, { recursive: true, force: true });
});
if (process.argv[1]?.endsWith('.test.ts'))
  setTimeout(() => {
    console.error('Isolated test watchdog: file exceeded 90 seconds');
    process.exit(124);
  }, 90000).unref();
