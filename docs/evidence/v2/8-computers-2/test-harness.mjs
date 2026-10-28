import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
// The agents test uses a fixed 5196–5197 range. Remap both ends without binding it.
const aliases = new Map([
  [5196, 5186],
  [5197, 5187],
]);
const listen = net.Server.prototype.listen;
let nextPort = process.argv[1]?.endsWith('/workspace/worker.ts') ? 5187 : 5186;
net.Server.prototype.listen = function (...args) {
  if (typeof args[0] === 'number' && aliases.has(args[0])) args[0] = aliases.get(args[0]);
  else if (args[0] && typeof args[0] === 'object' && aliases.has(Number(args[0].port)))
    args[0] = { ...args[0], port: aliases.get(Number(args[0].port)) };
  const first = args[0];
  const port =
    typeof first === 'number'
      ? first
      : first && typeof first === 'object' && 'port' in first
        ? Number(first.port)
        : undefined;
  if (port !== undefined && port !== 0 && port !== 5186 && port !== 5187) {
    const error = Object.assign(new Error(`Test port unavailable: ${port}`), {
      code: 'EADDRINUSE',
    });
    queueMicrotask(() => this.emit('error', error));
    return this;
  }
  if (port === 0) {
    const chosen = new Error().stack.includes('at startServer') ? 5187 : nextPort;
    nextPort = chosen === 5186 ? 5187 : 5186;
    args[0] = typeof first === 'number' ? chosen : { ...first, port: chosen };
  }
  if (port !== undefined) {
    const assignedPort = typeof args[0] === 'object' ? Number(args[0].port) : Number(args[0]);
    const host = this instanceof tls.Server || assignedPort === 5187 ? '::1' : '127.0.0.1';
    if (typeof args[0] === 'object') args[0] = { ...args[0], host };
    else if (typeof args[1] === 'string') args[1] = host;
    else args.splice(1, 0, host);
  }
  return listen.apply(this, args);
};
// A separate loopback address keeps the assigned ports isolated from another worktree's fixture.
let connectingTls = false;
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const normalize = (values) => {
    if (Array.isArray(values[0])) {
      normalize(values[0]);
      return;
    }
    if (typeof values[0] !== 'object' && aliases.has(Number(values[0])))
      values[0] = aliases.get(Number(values[0]));
    const options = values[0];
    if (options && typeof options === 'object' && aliases.has(Number(options.port)))
      options.port = aliases.get(Number(options.port));
    if (
      options &&
      typeof options === 'object' &&
      [5186, 5187].includes(Number(options.port)) &&
      ['localhost', '127.0.0.1', undefined].includes(options.host)
    )
      options.host = connectingTls || Number(options.port) === 5187 ? '::1' : '127.0.0.1';
    else if (
      typeof options !== 'object' &&
      [5186, 5187].includes(Number(options)) &&
      ['localhost', '127.0.0.1'].includes(values[1])
    )
      values[1] = connectingTls || Number(options) === 5187 ? '::1' : '127.0.0.1';
  };
  normalize(args);
  return connect.apply(this, args);
};
const tlsConnect = tls.connect;
tls.connect = function (...args) {
  const options = args[0];
  if (
    options &&
    typeof options === 'object' &&
    [5186, 5187].includes(Number(options.port)) &&
    (['localhost', '127.0.0.1'].includes(options.host) || options.host?.endsWith('.local'))
  ) {
    const expectedHost = options.servername || options.host;
    args[0] = {
      ...options,
      host: '::1',
      servername: options.servername || undefined,
      checkServerIdentity: (_, cert) =>
        (options.checkServerIdentity || tls.checkServerIdentity)(expectedHost, cert),
    };
  }
  connectingTls = true;
  try {
    return tlsConnect.apply(this, args);
  } finally {
    connectingTls = false;
  }
};
const spawn = child.spawn;
child.spawn = function (cmd, args, options) {
  if (args?.some((arg) => arg.endsWith('/workspace/worker.ts')))
    options = { ...options, stdio: ['ignore', 'pipe', 'pipe'] };
  const result = spawn.call(this, cmd, args, options);
  if (args?.some((arg) => arg.endsWith('/workspace/worker.ts')))
    result.stderr?.on('data', (data) => process.stderr.write(data));
  if (args?.some((arg) => arg.endsWith('ci-test-fixture.mjs')))
    result.stderr?.on('data', (data) => process.stderr.write(data));
  return result;
};
const spawnSync = child.spawnSync;
child.spawnSync = function (cmd, args, options) {
  if (Array.isArray(args) && args.includes('--test'))
    args = [
      '--test-force-exit',
      '--test-reporter=tap',
      ...args.map((arg) => (arg.startsWith('--test-concurrency=') ? '--test-concurrency=1' : arg)),
    ];
  return spawnSync.call(this, cmd, args, options);
};
// Disable multicast announcements in the isolated harness; never advertise test apps on the LAN.
const bind = dgram.Socket.prototype.bind;
dgram.Socket.prototype.bind = function (...args) {
  const first = args[0];
  const port = typeof first === 'number' ? first : first?.port;
  if (port !== undefined) {
    const assigned = port === 5353 ? 5186 : port === 0 ? 5187 : port;
    if (assigned !== 5186 && assigned !== 5187)
      throw new Error(`Test UDP listener outside assigned ports: ${port}`);
    if (typeof first === 'object') args[0] = { ...first, port: assigned, address: '127.0.0.1' };
    else {
      args[0] = assigned;
      if (typeof args[1] === 'string' || args[1] === undefined) args[1] = '127.0.0.1';
      else args.splice(1, 0, '127.0.0.1');
    }
  }
  return bind.apply(this, args);
};
dgram.Socket.prototype.addMembership = function () {};
dgram.Socket.prototype.dropMembership = function () {};
dgram.Socket.prototype.setMulticastInterface = function () {};
dgram.Socket.prototype.setMulticastTTL = function () {};
dgram.Socket.prototype.setMulticastLoopback = function () {};
dgram.Socket.prototype.send = function (...args) {
  const callback = args.at(-1);
  if (typeof callback === 'function') queueMicrotask(() => callback(null));
  return this;
};
syncBuiltinESMExports();
