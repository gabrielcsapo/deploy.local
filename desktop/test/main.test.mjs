import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { coordinatorOrigin, CoordinatorClient } from '../src/client.mjs';
import { InboxModel, trayModel, roles, externalUrl } from '../src/model.mjs';
import { Vault } from '../src/vault.mjs';
import { WorkerManager } from '../src/worker.mjs';
import { render } from '../src/views.mjs';
import { activeControl, controlBody } from '../src/control.mjs';
const item = {
  id: 'question:color',
  state: 'waiting',
  title: 'Which color?',
  from: 'Scout',
  actions: [{ id: 'option:0', label: 'Blue' }],
};
test('coordinator URLs reject unsafe transports and ambiguous origins', () => {
  assert.equal(coordinatorOrigin(), 'https://deploy.local');
  assert.equal(coordinatorOrigin('127.0.0.1:5181'), 'https://127.0.0.1:5181');
  assert.equal(coordinatorOrigin('http://127.0.0.1:5181'), 'http://127.0.0.1:5181');
  for (const value of [
    'http://SER',
    'https://a:b@SER',
    'https://SER/dashboard',
    'file:///tmp/a',
    'https://SER/#x',
  ])
    assert.throws(() => coordinatorOrigin(value));
  assert.throws(() =>
    new CoordinatorClient('https://deploy.local').request('https://other.local/api'),
  );
  assert.throws(() => externalUrl('file:///etc/passwd'));
  assert.throws(() => externalUrl('javascript:alert(1)'));
});
test('inbox deduplicates replay, reflects answers elsewhere, and keeps cursor on empty pages', () => {
  const model = new InboxModel();
  assert.deepEqual(model.replace([item]), [item]);
  assert.deepEqual(model.apply({ events: [{ type: 'inbox', item }], cursor: 10 }), []);
  model.apply({ events: [{ type: 'inbox', item: { ...item, state: 'answered' } }], cursor: 11 });
  assert.equal(model.waiting().length, 0);
  model.apply({ events: [], cursor: 12 });
  assert.equal(model.cursor, 12);
});
test('unknown Live stays unavailable, decisions alone set the count', () => {
  const result = trayModel({
    online: false,
    summary: null,
    inbox: [item],
    worker: { state: 'Stopped' },
  });
  assert.equal(result.live, 'Unavailable');
  assert.equal(result.count, 1);
  assert.equal(result.failing, false);
  assert.equal(
    trayModel({ online: true, summary: { running: 7, failing: 1 }, inbox: [], worker: {} }).live,
    '7 running · 1 failing',
  );
});
test('preload exposes exactly the contracted surface and forwards only arguments', async () => {
  let surface,
    calls = [];
  vm.runInNewContext(readFileSync(new URL('../src/preload.cjs', import.meta.url), 'utf8'), {
    require: (name) => {
      assert.equal(name, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld: (key, value) => {
            assert.equal(key, 'deployDesktop');
            surface = value;
          },
        },
        ipcRenderer: {
          sendSync: () => null,
          invoke: (...args) => {
            calls.push(args);
            return Promise.resolve();
          },
        },
      };
    },
  });
  assert.deepEqual(Object.keys(surface).sort(), [
    'control',
    'notify',
    'openExternal',
    'setBadge',
    'worker',
  ]);
  assert.deepEqual(Object.keys(surface.worker).sort(), ['setRoles', 'status']);
  assert.deepEqual(Object.keys(surface.control), ['request']);
  await surface.notify('x');
  await surface.setBadge(2);
  await surface.worker.status();
  await surface.worker.setRoles({ takeTasks: true });
  await surface.control.request('y');
  await surface.openExternal('https://example.com');
  assert.deepEqual(
    calls.map((c) => c[0]),
    [
      'desktop:notify',
      'desktop:badge',
      'desktop:worker-status',
      'desktop:worker-roles',
      'desktop:control',
      'desktop:external',
    ],
  );
});
test('vault refuses plaintext Linux backend and roundtrips through safeStorage', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-vault-'));
  try {
    const plaintext = new Vault(join(root, 'session'), {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'basic_text',
    });
    assert.throws(() => plaintext.write({ token: 'secret' }));
    const vault = new Vault(join(root, 'session'), {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s).reverse(),
      decryptString: (b) => Buffer.from(b).reverse().toString(),
    });
    vault.write({ token: 'secret' });
    assert.deepEqual(vault.read(), { token: 'secret' });
    assert.equal(readFileSync(join(root, 'session'), 'utf8').includes('secret'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('unsupported roles are rejected, and screen use cannot outlive task permission', () => {
  assert.throws(() => roles({ runApps: true }));
  assert.throws(() => roles({ serveModels: true }));
  assert.throws(() => roles({ takeTasks: true, useScreen: true }, 'linux', true));
  assert.throws(() => roles({ useScreen: true }, 'darwin', true));
  assert.equal(roles({ takeTasks: true, useScreen: true }, 'darwin', true).useScreen, true);
});
test('managed worker enrolls once, reports heartbeat, stops only its owned child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-worker-'));
  let spawned,
    enrollmentCalls = 0;
  const manager = new WorkerManager({
    root,
    executable: '/runtime',
    entry: '/worker.mjs',
    spawnChild: (command, args, options) => {
      spawned = { command, args, options };
      const child = new EventEmitter();
      child.kill = (signal) => {
        assert.equal(signal, 'SIGTERM');
        queueMicrotask(() => child.emit('exit', 0));
      };
      return child;
    },
  });
  const client = {
    origin: 'http://127.0.0.1:5181',
    request: async () => {
      enrollmentCalls++;
      return { workerId: 'desktop-fixture', workerToken: 'test-token' };
    },
  };
  try {
    const enrollment = await manager.configure({ takeTasks: true }, client);
    assert.equal(manager.status().state, 'Starting');
    manager.child.emit('message', { type: 'heartbeat', online: true });
    manager.child.emit('message', { type: 'controls', taskIds: ['task'] });
    assert.equal(manager.status().state, 'Ready for tasks');
    assert.equal(spawned.options.env.DEPLOY_WORKER_TOKEN, 'test-token');
    assert.equal(spawned.options.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
    await manager.configure({ takeTasks: true }, client, enrollment);
    assert.equal(enrollmentCalls, 1);
    await manager.configure({ takeTasks: false }, client, enrollment);
    assert.equal(manager.child, null);
  } finally {
    await manager.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
test('control bar tracks this computer only and commands bind generation', () => {
  const s = {
    id: 'session',
    workerId: 'desktop-fixture',
    kind: 'computer',
    status: 'active',
    expiresAt: Date.now() + 10000,
    generation: 'current',
  };
  assert.equal(activeControl([s], 'other'), undefined);
  assert.equal(activeControl([s], 'desktop-fixture'), s);
  assert.deepEqual(controlBody(s, 'client'), {
    sessionId: 'session',
    generation: 'current',
    clientId: 'client',
  });
});
test('shell escapes coordinator data and explains unsupported Linux control', () => {
  const html = render({
    page: 'setup',
    origin: 'https://deploy.local',
    name: '<img onerror=x>',
    platform: 'linux',
  });
  assert.equal(html.includes('<img'), false);
  assert.match(html, /Not supported on Windows or Linux yet/);
  assert.match(render({ page: 'offline', origin: 'https://deploy.local' }), /Unavailable/);
});
test('answers always carry desktop provenance and feature detection only hides absent Live', async () => {
  const client = new CoordinatorClient('https://deploy.local');
  const calls = [];
  client.request = async (...args) => {
    calls.push(args);
    return {};
  };
  await client.answer('question:color', 'option:0', 'Blue');
  assert.deepEqual(calls[0], [
    '/api/v2/inbox/question%3Acolor/answer',
    { method: 'POST', body: { actionId: 'option:0', on: 'desktop', note: 'Blue' } },
  ]);
  client.request = async () => {
    throw Object.assign(new Error('missing'), { status: 404 });
  };
  assert.equal(await client.live(), null);
  client.request = async () => {
    throw Object.assign(new Error('Unauthorized'), { status: 401 });
  };
  await assert.rejects(client.live(), /Unauthorized/);
});
