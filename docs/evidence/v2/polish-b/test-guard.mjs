import net from 'node:net';
import dgram from 'node:dgram';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
const listen = net.Server.prototype.listen;
const locks = new Set();
function reserve() {
  mkdirSync('/private/tmp/deploy-polish-b-port-locks', { recursive: true });
  let start = 5196;
  try {
    start = Number(readFileSync('/private/tmp/deploy-polish-b-next-port', 'utf8'));
  } catch {}
  for (let offset = 0; offset < 2; offset++) {
    const port = 5196 + ((start - 5196 + offset) % 2);
    if (
      spawnSync('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN'], {
        encoding: 'utf8',
      }).stdout.trim()
    )
      continue;
    const path = '/private/tmp/deploy-polish-b-port-locks/' + port;
    try {
      mkdirSync(path);
      writeFileSync(path + '/pid', String(process.pid));
      locks.add(path);
      writeFileSync('/private/tmp/deploy-polish-b-next-port', String(5196 + ((port - 5195) % 2)));
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
  } else if (Number.isFinite(port) && (port < 5196 || port > 5197)) {
    queueMicrotask(() =>
      this.emit(
        'error',
        Object.assign(new Error('Test port outside 5196–5197: ' + port), {
          code: port >= 5180 && port <= 5199 ? 'EADDRINUSE' : 'EACCES',
        }),
      ),
    );
    return this;
  }
  return listen.apply(this, args);
};
const bind = dgram.Socket.prototype.bind;
dgram.Socket.prototype.bind = function (...args) {
  const port = typeof args[0] === 'object' ? args[0].port : args[0];
  if (!(Number(port) >= 5196 && Number(port) <= 5197)) {
    queueMicrotask(() =>
      this.emit(
        'error',
        Object.assign(new Error('UDP disabled outside test port range'), {
          code: port >= 5180 && port <= 5199 ? 'EADDRINUSE' : 'EACCES',
        }),
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

// The task owns only two ports. Serialize files without modifying the application runner.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function (command, args, options) {
  return originalSpawnSync(
    command,
    Array.isArray(args)
      ? args.map((arg) => (arg === '--test-concurrency=4' ? '--test-concurrency=1' : arg))
      : args,
    options,
  );
};
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  // A restarted fixture reuses its HTTP port. With only two ports, its fresh
  // HTTPS probe can return that same port; give HTTPS the other assigned port.
  const env = options?.env;
  if (env?.PORT && env.PORT === env.HTTPS_PORT && ['5196', '5197'].includes(env.PORT))
    options = { ...options, env: { ...env, HTTPS_PORT: env.PORT === '5196' ? '5197' : '5196' } };
  return originalSpawn(command, args, options);
};
syncBuiltinESMExports();
