// Two-port isolation can reuse a closed probe; keep HTTP and HTTPS distinct on restart.
if (process.argv[1]?.endsWith('/server.ts') && process.env.PORT === process.env.HTTPS_PORT)
  process.env.HTTPS_PORT = process.env.PORT === '5192' ? '5193' : '5192';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const originalSpawn = childProcess.spawnSync;
childProcess.spawnSync = function (command, args, options) {
  return originalSpawn.call(
    this,
    command,
    Array.isArray(args)
      ? args.map((arg) => (arg === '--test-concurrency=4' ? '--test-concurrency=1' : arg))
      : args,
    options,
  );
};
syncBuiltinESMExports();
import net from 'node:net';
import dgram from 'node:dgram';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
const listen = net.Server.prototype.listen;
const locks = new Set();
mkdirSync('/private/tmp/v2-markup-port-locks', { recursive: true });
function reserve() {
  let start = 5192;
  try {
    start = Number(readFileSync('/private/tmp/v2-markup-next-port', 'utf8'));
  } catch {}
  for (let offset = 0; offset < 2; offset++) {
    const port = 5192 + ((start - 5192 + offset) % 2);
    if (
      spawnSync('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN'], {
        encoding: 'utf8',
      }).stdout.trim()
    )
      continue;
    const path = '/private/tmp/v2-markup-port-locks/' + port;
    try {
      mkdirSync(path);
      writeFileSync(path + '/pid', String(process.pid));
      locks.add(path);
      writeFileSync('/private/tmp/v2-markup-next-port', String(5192 + ((port - 5191) % 2)));
      return { port, path };
    } catch {
      try {
        process.kill(Number(readFileSync(path + '/pid', 'utf8')), 0);
      } catch (error) {
        if (error.code === 'ESRCH') rmSync(path, { recursive: true, force: true });
      }
    }
  }
  throw new Error('No permitted test ports available');
}
net.Server.prototype.listen = function (...args) {
  const options = args[0];
  const numeric =
    typeof options === 'number' || (typeof options === 'string' && /^\d+$/.test(options));
  const port = numeric
    ? Number(options)
    : options && typeof options === 'object'
      ? Number(options.port)
      : NaN;
  if (port === 0) {
    const lock = reserve();
    if (numeric) args[0] = lock.port;
    else args[0] = { ...options, port: lock.port };
    const release = () => {
      locks.delete(lock.path);
      rmSync(lock.path, { recursive: true, force: true });
    };
    this.once('close', release);
    this.once('error', release);
  } else if (Number.isFinite(port) && (port < 5192 || port > 5193)) {
    queueMicrotask(() =>
      this.emit(
        'error',
        Object.assign(new Error('Test port outside 5192–5193: ' + port), { code: 'EADDRINUSE' }),
      ),
    );
    return this;
  }
  return listen.apply(this, args);
};
const bind = dgram.Socket.prototype.bind;
dgram.Socket.prototype.bind = function (...args) {
  const port = typeof args[0] === 'object' ? args[0].port : args[0];
  if (!(Number(port) >= 5192 && Number(port) <= 5193)) {
    queueMicrotask(() =>
      this.emit(
        'error',
        Object.assign(new Error('UDP disabled outside test port range'), { code: 'EADDRINUSE' }),
      ),
    );
    return this;
  }
  return bind.apply(this, args);
};
process.on('exit', () => {
  for (const path of locks) rmSync(path, { recursive: true, force: true });
});

if (process.argv[1]?.endsWith('.test.ts')) {
  setTimeout(() => {
    console.error('Isolated test watchdog: file exceeded 90 seconds');
    process.exit(124);
  }, 90000).unref();
}
