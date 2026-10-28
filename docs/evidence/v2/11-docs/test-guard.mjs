import net from 'node:net';
import dgram from 'node:dgram';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
const listen = net.Server.prototype.listen;
const locks = new Set();
let applicationHttpPort;
const restartingHttpFixture = process.argv[1]?.endsWith('/application-api.test.ts');
function reserve() {
  let start = 5180;
  try {
    start = Number(readFileSync('/private/tmp/deploy-v2-docs-next-port', 'utf8'));
  } catch {}
  for (let offset = 0; offset < 2; offset++) {
    const port = 5180 + ((start - 5180 + offset) % 2);
    if (restartingHttpFixture && port === applicationHttpPort) continue;
    if (
      spawnSync('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN'], {
        encoding: 'utf8',
      }).stdout.trim()
    )
      continue;
    const path = '/private/tmp/deploy-v2-docs-port-locks/' + port;
    try {
      mkdirSync(path);
      writeFileSync(path + '/pid', String(process.pid));
      locks.add(path);
      writeFileSync('/private/tmp/deploy-v2-docs-next-port', String(5180 + ((port - 5179) % 2)));
      if (restartingHttpFixture && applicationHttpPort === undefined) applicationHttpPort = port;
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
  } else if (Number.isFinite(port) && (port < 5180 || port > 5181)) {
    queueMicrotask(() =>
      this.emit(
        'error',
        Object.assign(new Error('Test port outside 5180–5181: ' + port), { code: 'EACCES' }),
      ),
    );
    return this;
  }
  return listen.apply(this, args);
};
const bind = dgram.Socket.prototype.bind;
dgram.Socket.prototype.bind = function (...args) {
  const port = typeof args[0] === 'object' ? args[0].port : args[0];
  if (!(Number(port) >= 5180 && Number(port) <= 5181)) {
    queueMicrotask(() =>
      this.emit(
        'error',
        Object.assign(new Error('UDP disabled outside test port range'), { code: 'EACCES' }),
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

const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function (command, args, options) {
  if (Array.isArray(args))
    args = args.map((arg) => (arg === '--test-concurrency=4' ? '--test-concurrency=1' : arg));
  return originalSpawnSync.call(this, command, args, options);
};
syncBuiltinESMExports();
