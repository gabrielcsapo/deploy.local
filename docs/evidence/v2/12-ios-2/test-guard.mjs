// Isolate this worktree's suite from services and the other agents' assigned ports.
import net from 'node:net';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const first = args[0];
  const numeric = typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first));
  const port = numeric
    ? Number(first)
    : first && typeof first === 'object'
      ? Number(first.port)
      : NaN;
  if (port === 0) {
    if (numeric) args[0] = 5186;
    else args[0] = { ...first, port: 5186 };
  } else if (Number.isFinite(port) && port !== 5186) {
    queueMicrotask(() =>
      this.emit(
        'error',
        Object.assign(new Error('Test listener outside assigned port 5186'), { code: 'EACCES' }),
      ),
    );
    return this;
  }
  return listen.apply(this, args);
};
const bind = dgram.Socket.prototype.bind;
dgram.Socket.prototype.bind = function (...args) {
  const port = typeof args[0] === 'object' ? args[0].port : args[0];
  if (Number(port) !== 5186) {
    queueMicrotask(() =>
      this.emit(
        'error',
        Object.assign(new Error('UDP listener outside assigned port 5186'), { code: 'EACCES' }),
      ),
    );
    return this;
  }
  return bind.apply(this, args);
};
const spawnSync = childProcess.spawnSync;
childProcess.spawnSync = function (command, args, options) {
  return spawnSync(
    command,
    args?.map((arg) => (arg === '--test-concurrency=4' ? '--test-concurrency=1' : arg)),
    options,
  );
};
syncBuiltinESMExports();
if (process.argv[1]?.endsWith('.test.ts'))
  setTimeout(() => {
    console.error('Isolated test watchdog: file exceeded 90 seconds');
    process.exit(124);
  }, 90000).unref();
