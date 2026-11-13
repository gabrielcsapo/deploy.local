import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, connect } from 'node:net';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { superviseWorker, workerUpdateReceipt } from './worker-supervisor.mjs';
import { installWorkerBuild } from './worker-update.mjs';
import { createHash } from 'node:crypto';
import { createRelayController, relayRequest } from './relay-client.mjs';
import { spawn } from 'node:child_process';
import { bundleCli } from '../scripts/build-cli.mjs';
import { closeRelay, readRelayState, writeRelayState } from './relay-process.mjs';

async function waitFor(check) {
  for (let i = 0; i < 500; i++) {
    const value = await check();
    if (value) return value;
    await delay(10);
  }
  throw new Error('Timed out waiting for relay fixture');
}
async function echo(t, prefix = '') {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    socket.on('data', (data) => socket.write(prefix + data));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}
async function connection(t, port) {
  const socket = connect({ port, host: '127.0.0.1' });
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  return socket;
}
async function bytes(socket, value) {
  const data = once(socket, 'data', { signal: AbortSignal.timeout(2000) });
  socket.write(value);
  return String((await data)[0]);
}
function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'relay-process-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function read(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
async function fixture(t, { rows = [], failRelay = false, heartbeatMs = 60_000 } = {}) {
  const root = temp(t);
  const path = join(root, 'relays.json');
  writeFileSync(path, JSON.stringify(rows));
  const workerFile = join(root, 'worker.json');
  const relayFile = join(root, 'relay.json');
  const script = join(root, 'entry.mjs');
  writeFileSync(
    script,
    `
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {runRelayProcess} from ${JSON.stringify(new URL('./relay-process.mjs', import.meta.url).href)};
import {createRelayController} from ${JSON.stringify(new URL('./relay-client.mjs', import.meta.url).href)};
const root = ${JSON.stringify(root)};
if (process.argv[2] === 'relay') {
  if (${failRelay}) process.exit(9);
  writeFileSync(root+'/relay.json',JSON.stringify({pid:process.pid}));
  await runRelayProcess({host:'127.0.0.1'});
} else {
  const controller = createRelayController({path:root+'/relays.json',host:'127.0.0.1'});
  await controller.restore();
  const report = () => writeFileSync(root+'/worker.json',JSON.stringify({pid:process.pid,rows:[...controller.relays].map(([name,row])=>({name,...row,server:undefined,sockets:undefined}))}));
  report();
  process.send({type:'worker-ready',token:process.env.DEPLOY_WORKER_CHILD,version:'test'});
  process.once('disconnect',()=>process.exit(0));
  setInterval(()=>process.send({type:'worker-heartbeat',token:process.env.DEPLOY_WORKER_CHILD}),20);
  let busy=false;
  setInterval(async()=>{
    if(busy)return;
    busy=true;
    try {
      if(existsSync(root+'/command.json')) {
        const c=JSON.parse(readFileSync(root+'/command.json','utf8'));
        if(c.remove) await controller.remove(c.name);
        else await controller.ensure(c.name,c.targetPort,c.preferredPort,c.containerName);
      }
      await controller.refresh(); report();
    } catch(error) {writeFileSync(root+'/error',error.stack)}
    finally{busy=false}
  },30);
}
`,
  );
  const controller = new AbortController();
  const logs = [];
  const running = superviseWorker({
    executable: process.execPath,
    args: [script, 'worker'],
    relay: {
      executable: process.execPath,
      args: [script, 'relay'],
      path,
      startupMs: 500,
      retryMs: 30,
    },
    root,
    version: 'test',
    startupMs: 2000,
    heartbeatMs,
    watchdogIntervalMs: 20,
    killGraceMs: 30,
    signal: controller.signal,
    log: (line) => logs.push(line),
  });
  t.after(async () => {
    controller.abort();
    await running;
  });
  await waitFor(() => read(workerFile));
  return {
    root,
    path,
    worker: () => read(workerFile),
    relay: () => read(relayFile),
    logs,
    command: (value) => writeFileSync(join(root, 'command.json'), JSON.stringify(value)),
  };
}

test(
  'relay bytes survive a frozen worker and its watchdog replacement',
  { timeout: 10_000 },
  async (t) => {
    const targetPort = await echo(t);
    const f = await fixture(t, {
      rows: [{ deploymentName: 'app', targetPort, relayPort: 0 }],
      heartbeatMs: 150,
    });
    const worker = f.worker(),
      relay = f.relay();
    const port = worker.rows[0].relayPort;
    const stream = await connection(t, port);
    assert.equal(await bytes(stream, 'before'), 'before');
    process.kill(worker.pid, 'SIGSTOP');
    assert.equal(await bytes(stream, 'frozen'), 'frozen');
    assert.equal(await bytes(await connection(t, port), 'new while frozen'), 'new while frozen');
    await waitFor(() => f.worker()?.pid !== worker.pid);
    assert.equal(await bytes(stream, 'restarted'), 'restarted');
    assert.equal(f.relay().pid, relay.pid);
    assert.equal(f.worker().rows[0].relayPort, port);
    assert.ok(f.logs.some((line) => line.includes('heartbeat stopped')));
    process.kill(f.worker().pid, 'SIGKILL');
    const latest = f.worker().pid;
    assert.equal(await bytes(stream, 'killed'), 'killed');
    await waitFor(() => f.worker()?.pid !== latest);
    assert.equal(await bytes(stream, 'replaced again'), 'replaced again');
    assert.equal(f.relay().pid, relay.pid);
  },
);

test(
  'target updates preserve both listeners and all existing streams; removal touches one relay',
  { timeout: 10_000 },
  async (t) => {
    const first = await echo(t, 'first:');
    const second = await echo(t, 'second:');
    const f = await fixture(t, {
      rows: [
        { deploymentName: 'a', targetPort: first, relayPort: 0 },
        { deploymentName: 'b', targetPort: first, relayPort: 0 },
      ],
    });
    const [a, b] = f.worker().rows;
    const aStream = await connection(t, a.relayPort);
    const bStream = await connection(t, b.relayPort);
    assert.equal(await bytes(aStream, 'old'), 'first:old');
    f.command({ name: 'a', targetPort: second });
    await waitFor(() => f.worker().rows.find((row) => row.name === 'a').targetPort === second);
    assert.equal(f.worker().rows.find((row) => row.name === 'a').relayPort, a.relayPort);
    assert.equal(await bytes(aStream, 'existing'), 'first:existing');
    assert.equal(await bytes(bStream, 'unrelated'), 'first:unrelated');
    assert.equal(await bytes(await connection(t, a.relayPort), 'new'), 'second:new');
    f.command({ name: 'a', remove: true });
    await waitFor(() => f.worker().rows.length === 1);
    assert.equal(await bytes(bStream, 'after remove'), 'first:after remove');
  },
);

test(
  'wanted-port conflict reports and saves the bound port, then reclaims the wanted port',
  { timeout: 10_000 },
  async (t) => {
    const targetPort = await echo(t, 'target:');
    const squatter = createServer();
    squatter.listen(0, '127.0.0.1');
    await once(squatter, 'listening');
    t.after(() => squatter.close());
    const wantedPort = squatter.address().port;
    const f = await fixture(t, {
      rows: [{ deploymentName: 'a', targetPort, relayPort: wantedPort, wantedPort }],
    });
    const actual = f.worker().rows[0].relayPort;
    assert.notEqual(actual, wantedPort);
    assert.equal(readRelayState(f.path)[0].relayPort, actual);
    assert.equal(readRelayState(f.path)[0].wantedPort, wantedPort);
    assert.equal(await bytes(await connection(t, actual), 'fallback'), 'target:fallback');
    await new Promise((resolve) => squatter.close(resolve));
    f.command({ name: 'a', targetPort, preferredPort: wantedPort });
    await waitFor(() => f.worker().rows[0].relayPort === wantedPort);
    assert.equal(await bytes(await connection(t, wantedPort), 'reclaimed'), 'target:reclaimed');
  },
);

test(
  'supervisor restores every saved relay after a relay process crash while the worker is frozen',
  { timeout: 10_000 },
  async (t) => {
    const targetPort = await echo(t);
    const f = await fixture(t, {
      rows: ['a', 'b'].map((deploymentName) => ({ deploymentName, targetPort, relayPort: 0 })),
    });
    const old = f.relay().pid;
    const worker = f.worker();
    process.kill(worker.pid, 'SIGSTOP');
    t.after(() => {
      try {
        process.kill(worker.pid, 'SIGCONT');
      } catch {}
    });
    process.kill(old, 'SIGKILL');
    await waitFor(() => f.relay()?.pid !== old);
    for (const row of worker.rows) {
      // The pid file precedes readiness; wait for the restored port to be reachable.
      await waitFor(async () => {
        try {
          return (await bytes(await connection(t, row.relayPort), 'restored')) === 'restored';
        } catch {
          return false;
        }
      });
    }
    process.kill(worker.pid, 'SIGCONT');
    assert.equal(f.worker().pid, worker.pid);
    assert.ok(f.logs.some((line) => line.includes('Relay process exited')));
  },
);

test('an old supervisor or an unsupervised worker uses in-process relays', async (t) => {
  const root = temp(t),
    path = join(root, 'relays.json');
  const targetPort = await echo(t);
  writeFileSync(path, JSON.stringify([{ deploymentName: 'saved', targetPort, relayPort: 0 }]));
  const controller = createRelayController({ path, request: null, host: '127.0.0.1' });
  t.after(async () => {
    for (const name of controller.relays.keys()) await closeRelay(controller.relays, name);
  });
  await controller.restore();
  const port = await controller.ensure('saved', targetPort);
  assert.ok(controller.relays.get('saved').server);
  assert.equal(await bytes(await connection(t, port), 'local'), 'local');
  await controller.remove('saved');
  assert.deepEqual(readRelayState(path), []);
});

test(
  'relay start failure grants exclusive fallback and worker replacements retry it',
  { timeout: 10_000 },
  async (t) => {
    const targetPort = await echo(t);
    const f = await fixture(t, {
      failRelay: true,
      rows: [{ deploymentName: 'a', targetPort, relayPort: 0 }],
    });
    const worker = f.worker();
    const port = worker.rows[0].relayPort;
    assert.equal(await bytes(await connection(t, port), 'local'), 'local');
    assert.equal(existsSync(join(f.root, 'relay.json')), false);
    process.kill(worker.pid, 'SIGKILL');
    await waitFor(() => f.worker()?.pid !== worker.pid);
    assert.equal(f.worker().rows[0].relayPort, port);
    assert.equal(await bytes(await connection(t, port), 'again'), 'again');
  },
);

test('IPC timeout never grants unsafe in-process ownership', async (t) => {
  const path = join(temp(t), 'relays.json');
  const controller = createRelayController({
    path,
    request: async () => {
      throw new Error('timeout');
    },
  });
  await assert.rejects(controller.ensure('a', 1234), /timeout/);
  assert.equal(controller.relays.size, 0);
});

test('state writes preserve the existing schema and replace the whole file atomically', (t) => {
  const path = join(temp(t), 'relays.json');
  const rows = new Map([
    ['a', { targetPort: 123, relayPort: 456, wantedPort: 789, containerName: 'container' }],
  ]);
  writeRelayState(path, rows);
  assert.deepEqual(readRelayState(path), [
    {
      deploymentName: 'a',
      targetPort: 123,
      relayPort: 456,
      wantedPort: 789,
      containerName: 'container',
    },
  ]);
  assert.equal(existsSync(path + '.tmp'), false);
});

test(
  'IPC lifecycle keeps the relay pid through watchdog restarts and recovers a relay crash',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t, { heartbeatMs: 150 });
    const worker = f.worker().pid,
      relay = f.relay().pid;
    process.kill(worker, 'SIGSTOP');
    await waitFor(() => f.worker()?.pid !== worker);
    assert.equal(f.relay().pid, relay);
    assert.ok(f.logs.some((line) => line.includes('heartbeat stopped')));
    const replacement = f.worker().pid;
    process.kill(relay, 'SIGKILL');
    await waitFor(() => f.relay()?.pid !== relay);
    await delay(100);
    assert.equal(f.worker().pid, replacement);
    assert.equal(existsSync(join(f.root, 'error')), false);
  },
);

test(
  'IPC startup failure falls back without restarting the worker or leaving retrying children',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t, { failRelay: true });
    const worker = f.worker().pid;
    const attempts = f.logs.length;
    await delay(150);
    assert.equal(f.worker().pid, worker);
    assert.equal(f.logs.length, attempts);
    assert.equal(existsSync(join(f.root, 'error')), false);
  },
);

test('serialized worker requests persist complete desired sets and consume real bound ports', async (t) => {
  const path = join(temp(t), 'relays.json');
  const snapshots = [];
  let active = 0,
    maxActive = 0;
  const controller = createRelayController({
    path,
    request: async () => {
      maxActive = Math.max(maxActive, ++active);
      const rows = readRelayState(path);
      snapshots.push(rows);
      await delay(5);
      active--;
      return {
        relays: rows.map((row) => ({
          ...row,
          relayPort: row.relayPort || 4567,
          wantedPort: row.wantedPort || 4567,
        })),
      };
    },
  });
  await Promise.all([controller.ensure('a', 123), controller.ensure('b', 234)]);
  assert.equal(maxActive, 1);
  assert.deepEqual(
    snapshots.map((rows) => rows.map((row) => row.deploymentName)),
    [[], ['a'], ['a', 'b']],
  );
  assert.equal(controller.relays.get('a').relayPort, 4567);
  assert.equal(readRelayState(path).length, 2);
  await controller.remove('a');
  assert.deepEqual(
    readRelayState(path).map((row) => row.deploymentName),
    ['b'],
  );
});

test(
  'the SEA bootstrap runs agent relay and protocol 1 from the single CLI bundle',
  { timeout: 15_000 },
  async (t) => {
    const root = temp(t),
      path = join(root, 'relays.json');
    writeFileSync(path, '[]');
    await bundleCli({ version: 'relay-test', packageVersion: '1.0.0', commit: 'unknown' }, root);
    const child = spawn(process.execPath, [join(root, 'launcher.cjs'), 'agent', 'relay'], {
      cwd: root,
      env: {
        ...process.env,
        DEPLOY_AGENT_CONFIG: join(root, 'agent.json'),
        DEPLOY_DATA_DIR: join(root, 'data'),
        DEPLOY_MDNS_ADDRESS: '127.0.0.1',
        DEPLOY_RELAY_STATE: path,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let errors = '';
    child.stdout.resume();
    child.stderr.on('data', (data) => (errors += data));
    t.after(async () => {
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, 'exit');
        child.kill('SIGKILL');
        await stopped;
      }
    });
    const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
    assert.equal(ready.type, 'relay-ready', errors);
    assert.equal(ready.protocol, 1);
    const result = await relayRequest(child, 3000)();
    assert.deepEqual(result.relays, []);
    assert.deepEqual(result.errors, []);
    const stopped = once(child, 'exit');
    child.disconnect();
    await stopped;
    assert.equal(child.exitCode, 0, errors);
  },
);

test(
  'worker self-update keeps the old relay process and protocol working, including relay crash recovery',
  { timeout: 10_000 },
  async (t) => {
    const root = temp(t),
      path = join(root, 'relays.json');
    writeFileSync(path, '[]');
    const executable = join(root, 'worker'),
      supervisor = join(root, 'supervisor');
    const binary = (version) =>
      Buffer.from(`#!/bin/sh
exec "${process.execPath}" --input-type=module - "$@" <<'WORKER'
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {runRelayProcess} from ${JSON.stringify(new URL('./relay-process.mjs', import.meta.url).href)};
import {createRelayController} from ${JSON.stringify(new URL('./relay-client.mjs', import.meta.url).href)};
const root=${JSON.stringify(root)},version=${JSON.stringify(version)};
if(process.argv[2]==='version'){console.log(JSON.stringify({version}));process.exit(0)}
if(process.argv[3]==='relay'){
  writeFileSync(root+'/relay.json',JSON.stringify({pid:process.pid,version}));
  await runRelayProcess();
}else{
  const controller=createRelayController({path:root+'/relays.json'});
  await controller.restore();
  writeFileSync(root+'/worker.json',JSON.stringify({pid:process.pid,version}));
  process.send({type:'worker-ready',token:process.env.DEPLOY_WORKER_CHILD,version});
  if(version==='old'&&!existsSync(root+'/requested')){
    writeFileSync(root+'/requested','1');
    process.send({type:'worker-update',request:JSON.parse(readFileSync(root+'/request.json','utf8'))});
  }
  process.once('disconnect',()=>process.exit(0));
  setInterval(async()=>{
    await controller.refresh();
    process.send({type:'worker-heartbeat',token:process.env.DEPLOY_WORKER_CHILD});
    writeFileSync(root+'/heartbeat',version);
  },30);
}
WORKER
`);
    const old = binary('old'),
      next = binary('new');
    writeFileSync(executable, old, { mode: 0o755 });
    writeFileSync(supervisor, old, { mode: 0o755 });
    writeFileSync(
      join(root, 'request.json'),
      JSON.stringify({
        targetVersion: 'new',
        sha256: createHash('sha256').update(next).digest('hex'),
        size: next.length,
      }),
    );
    const controller = new AbortController();
    const running = superviseWorker({
      executable,
      root,
      version: 'old',
      relay: { executable: supervisor, path, retryMs: 20 },
      signal: controller.signal,
      stableMs: 100,
      download: async () => next,
      install: (options) => installWorkerBuild({ ...options, platform: 'linux' }),
      log: () => {},
    });
    t.after(async () => {
      controller.abort();
      await running;
    });
    const relay = await waitFor(() => read(join(root, 'relay.json')));
    await waitFor(() => workerUpdateReceipt(root)?.state === 'complete');
    assert.equal(read(join(root, 'worker.json')).version, 'new');
    assert.deepEqual(read(join(root, 'relay.json')), relay);
    assert.equal(relay.version, 'old');
    const worker = read(join(root, 'worker.json')).pid;
    process.kill(relay.pid, 'SIGKILL');
    await waitFor(() => read(join(root, 'relay.json'))?.pid !== relay.pid);
    await delay(100);
    assert.equal(read(join(root, 'relay.json')).version, 'old');
    assert.equal(read(join(root, 'worker.json')).pid, worker);
    assert.equal(readFileSync(join(root, 'heartbeat'), 'utf8'), 'new');
  },
);
