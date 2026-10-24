import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { TerminalRelay, type TerminalComputer } from './terminal-relay.ts';
import { runWorkerTerminal } from './terminal-worker.ts';
process.env.DEPLOY_DATA_DIR = mkdtempSync(join(tmpdir(), 'deploy-terminal-test-'));
const { save, events } = await import('./store.ts');
const { terminalRelay, setTerminalPermission, terminalStatus } =
  await import('./terminal-service.ts');
const { acceptTerminalBrowser, handleTerminalUpgrade } = await import('./terminal-socket.ts');
const { workspaceApi } = await import('./api.ts');
const { enrollWorker, workerAuthentication } = await import('./credentials.ts');
after(() => terminalRelay.dispose());
class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: { data: Buffer | string; binary: boolean }[] = [];
  peer?: FakeSocket;
  send(data: string | Buffer, options?: { binary?: boolean }) {
    this.sent.push({ data, binary: !!options?.binary });
    queueMicrotask(() => {
      if (this.peer?.readyState === WebSocket.OPEN)
        this.peer.emit(
          'message',
          Buffer.isBuffer(data) ? data : Buffer.from(data),
          !!options?.binary,
        );
    });
  }
  close() {
    if (this.readyState !== WebSocket.OPEN) return;
    this.readyState = WebSocket.CLOSED;
    queueMicrotask(() => {
      this.emit('close');
      this.peer?.close();
    });
  }
  terminate() {
    this.close();
  }
  ping() {
    this.emit('pong');
  }
  ws() {
    return this as unknown as WebSocket;
  }
}
function pair() {
  const a = new FakeSocket(),
    b = new FakeSocket();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await delay(20);
  }
  assert.ok(check(), 'Timed out');
}
const computer: TerminalComputer = {
  id: 'ser',
  name: 'SER',
  instanceId: 'instance',
  enabled: true,
  online: true,
  supported: true,
  locallyDisabled: false,
};
function fixture(extra: Partial<TerminalComputer> = {}) {
  let time = 1000;
  const audits: any[] = [];
  const state = { ...computer, ...extra };
  const relay = new TerminalRelay({
    computer: (owner, worker) => {
      if (owner !== 'owner' || worker !== 'ser') throw new Error('Not found');
      return state;
    },
    audit: (type, entry) => audits.push({ type, ...entry }),
    now: () => time,
    idleMs: 100,
    maxMs: 500,
  });
  const browser = new FakeSocket();
  const start = () =>
    relay.start('owner', 'ser', browser.ws(), 80, 24, {
      ip: '192.0.2.1',
      userAgent: 'test browser',
    });
  return {
    relay,
    browser,
    start,
    state,
    audits,
    advance: (ms: number) => {
      time += ms;
      relay.sweep();
    },
  };
}
test(
  'browser ⇄ relay ⇄ worker ⇄ real PTY: printf, UTF-8, resize, exit and audits',
  { timeout: 10000 },
  async () => {
    const f = fixture();
    const [control, worker] = pair();
    let output = Buffer.alloc(0);
    f.browser.on('message', () => {});
    const id = f.start();
    const assignment = f.relay.assignments('owner', 'ser', 'instance')[0];
    const stop = runWorkerTerminal(worker.ws(), assignment);
    f.relay.attachWorker({ owner: 'owner', workerId: 'ser' }, assignment, control.ws());
    const drain = setInterval(() => {
      for (const item of f.browser.sent.splice(0))
        if (item.binary) {
          const bytes = Buffer.from(item.data);
          output = Buffer.concat([output, bytes]);
          f.browser.emit(
            'message',
            Buffer.from(JSON.stringify({ type: 'exec:ack', bytes: bytes.length })),
            false,
          );
        }
    }, 5);
    try {
      await until(() => control.sent.some((m) => String(m.data).includes('exec:start')));
      await delay(100);
      f.browser.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'exec:resize', cols: 99, rows: 31 })),
        false,
      );
      f.browser.emit('message', Buffer.from("stty size; printf '\\122\\105LAY:🌍\\n'\n"), true);
      await until(
        () => output.toString().includes('31 99') && output.toString().includes('RELAY:🌍'),
      );
      f.browser.emit('message', Buffer.from('exit 7\n'), true);
      await until(() => !f.relay.sessions.has(id));
      assert.equal(f.audits[1].code, 7);
      assert.equal(f.audits[0].ip, '192.0.2.1');
      assert.equal(f.audits[1].type, 'terminal.ended');
      assert.ok(!JSON.stringify(f.audits).includes('printf'));
    } finally {
      clearInterval(drain);
      stop();
      f.relay.dispose();
    }
  },
);
test('off, offline, unsupported, local kill switch, wrong owner and wrong worker refuse terminals', () => {
  for (const state of [
    { enabled: false },
    { online: false },
    { supported: false },
    { locallyDisabled: true },
  ]) {
    const f = fixture(state);
    assert.throws(f.start);
    f.relay.dispose();
  }
  const f = fixture();
  try {
    assert.throws(() =>
      f.relay.start('intruder', 'ser', f.browser.ws(), 80, 24, { ip: '', userAgent: '' }),
    );
    f.start();
    const assignment = f.relay.assignments('owner', 'ser', 'instance')[0];
    for (const identity of [
      { owner: 'intruder', workerId: 'ser' },
      { owner: 'owner', workerId: 'other' },
    ])
      assert.throws(() => f.relay.attachWorker(identity, assignment, new FakeSocket().ws()));
    assert.throws(() =>
      f.relay.attachWorker(
        { owner: 'owner', workerId: 'ser' },
        { ...assignment, owner: 'other' },
        new FakeSocket().ws(),
      ),
    );
    assert.throws(() =>
      f.relay.attachWorker(
        { owner: 'owner', workerId: 'ser' },
        { ...assignment, instanceId: 'other' },
        new FakeSocket().ws(),
      ),
    );
  } finally {
    f.relay.dispose();
  }
});
test('idle timeout, max duration, cap, disconnect and immediate disable', () => {
  const f = fixture();
  try {
    f.start();
    f.advance(101);
    assert.equal(f.audits.at(-1).reason, 'Ended after 30 minutes without input');
    f.start();
    f.relay.disable('owner', 'ser');
    assert.equal(f.relay.sessions.size, 0);
    for (let i = 0; i < 4; i++) f.start();
    assert.throws(f.start, /four/);
    f.relay.disable('owner', 'ser');
    const id = f.start();
    f.relay.sessions.get(id)!.inputAt += 1000;
    f.advance(501);
    assert.equal(f.audits.at(-1).reason, 'Maximum session length reached');
  } finally {
    f.relay.dispose();
  }
});
test('worker rejects an unassigned owner/id and the local kill switch before spawning', async () => {
  for (const disabled of [false, true]) {
    const [control, worker] = pair();
    const assignment = {
      id: 'id',
      owner: 'owner',
      workerId: 'ser',
      instanceId: 'instance',
      cols: 80,
      rows: 24,
    };
    runWorkerTerminal(worker.ws(), assignment, disabled);
    control.send(
      JSON.stringify({ type: 'exec:start', ...assignment, owner: disabled ? 'owner' : 'other' }),
    );
    await until(() => worker.readyState === WebSocket.CLOSED);
    assert.ok(
      worker.sent.some((m) => String(m.data).includes(disabled ? 'disabled locally' : 'mismatch')),
    );
    assert.ok(!worker.sent.some((m) => String(m.data).includes('exec:ready')));
  }
});
test('owner permission persists, disabling closes immediately, audits are workspace events, worker token cannot open or enable', async () => {
  save('worker', 'owner', {
    id: 'ser',
    name: 'SER',
    instanceId: 'instance',
    capabilities: ['terminal'],
    heartbeat: new Date().toISOString(),
  });
  assert.equal(terminalStatus('owner', 'ser').enabled, false);
  setTerminalPermission('owner', 'ser', true);
  const browser = new FakeSocket();
  terminalRelay.start('owner', 'ser', browser.ws(), 80, 24, {
    ip: '192.0.2.1',
    userAgent: 'browser',
  });
  setTerminalPermission('owner', 'ser', false);
  assert.equal(terminalRelay.sessions.size, 0);
  const audit = events('owner').filter((e) => e.type === 'terminal.ended');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].payload.ip, '192.0.2.1');
  const credential = enrollWorker('owner', { workerId: 'ser' });
  const browserRequest = { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage;
  const unauth = new FakeSocket();
  acceptTerminalBrowser(unauth.ws(), browserRequest, terminalRelay);
  unauth.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        auth: { username: 'owner', token: credential.workerToken },
        workerId: 'ser',
        cols: 80,
        rows: 24,
      }),
    ),
    false,
  );
  assert.equal(unauth.readyState, WebSocket.CLOSED);
  const server = createServer((req, res) => {
    const auth = workerAuthentication(req);
    void workspaceApi(req, res, auth!.owner, auth!.workerId);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as any).port}/api/workspace/computers/ser/terminal`,
      {
        method: 'POST',
        headers: { 'x-deploy-worker-id': 'ser', 'x-deploy-worker-token': credential.workerToken },
        body: JSON.stringify({ enabled: true }),
      },
    );
    assert.equal(response.status, 403);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
test('long poll wakes immediately for an owner request and never exposes another identity', async () => {
  const f = fixture();
  const abort = new AbortController();
  try {
    const pending = f.relay.poll('owner', 'ser', 'instance', abort.signal);
    f.start();
    assert.equal((await pending).length, 1);
    assert.deepEqual(f.relay.assignments('other', 'ser', 'instance'), []);
    assert.deepEqual(f.relay.assignments('owner', 'other', 'instance'), []);
  } finally {
    abort.abort();
    f.relay.dispose();
  }
});

test('relay preserves split UTF-8 and closes slow or invalid consumers without dropping bytes', () => {
  const f = fixture();
  try {
    f.start();
    const worker = new FakeSocket();
    const assignment = f.relay.assignments('owner', 'ser', 'instance')[0];
    f.relay.attachWorker({ owner: 'owner', workerId: 'ser' }, assignment, worker.ws());
    const bytes = Buffer.from('🌍');
    worker.emit('message', bytes.subarray(0, 2), true);
    worker.emit('message', bytes.subarray(2), true);
    assert.deepEqual(
      Buffer.concat(
        f.browser.sent.filter((item) => item.binary).map((item) => Buffer.from(item.data)),
      ),
      bytes,
    );
    f.browser.emit('message', Buffer.from(JSON.stringify({ type: 'exec:ack', bytes: 4 })), false);
    assert.equal(f.relay.sessions.get(assignment.id)?.pendingBytes, 0);
    f.browser.bufferedAmount = 1024 * 1024 + 1;
    worker.emit('message', Buffer.from('next'), true);
    assert.equal(f.relay.sessions.size, 0);
    assert.match(f.audits.at(-1).reason, /too slow/);
  } finally {
    f.relay.dispose();
  }
});

test('reenrollment resets shell consent and immediately closes an old credential session', () => {
  setTerminalPermission('owner', 'ser', true);
  const browser = new FakeSocket();
  terminalRelay.start('owner', 'ser', browser.ws(), 80, 24, { ip: '', userAgent: '' });
  enrollWorker('owner', { workerId: 'ser' });
  assert.equal(terminalRelay.sessions.size, 0);
  assert.equal(terminalStatus('owner', 'ser').enabled, false);
});

test('a socket upgraded before credential rotation cannot attach to a newly assigned terminal', async () => {
  const credential = enrollWorker('owner', { workerId: 'ser' });
  const server = createServer();
  server.on('upgrade', handleTerminalUpgrade);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const socket = new WebSocket(
    `ws://127.0.0.1:${(server.address() as any).port}/ws/terminal/worker`,
    { headers: { 'x-deploy-worker-id': 'ser', 'x-deploy-worker-token': credential.workerToken } },
  );
  try {
    await once(socket, 'open');
    enrollWorker('owner', { workerId: 'ser' });
    setTerminalPermission('owner', 'ser', true);
    terminalRelay.start('owner', 'ser', new FakeSocket().ws(), 80, 24, { ip: '', userAgent: '' });
    const closed = once(socket, 'close');
    socket.send(JSON.stringify(terminalRelay.assignments('owner', 'ser', 'instance')[0]));
    assert.equal((await closed)[0], 1008);
    assert.equal([...terminalRelay.sessions.values()][0].worker, undefined);
  } finally {
    socket.terminate();
    terminalRelay.disable('owner', 'ser');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
