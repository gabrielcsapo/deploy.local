import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { coordinatorOrigin, CoordinatorClient } from '../src/client.mjs';
import { InboxModel, trayModel, roles, externalUrl } from '../src/model.mjs';
import { Vault } from '../src/vault.mjs';
import { WorkerManager, localNodeId } from '../src/worker.mjs';
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
    nodeId: (origin) => (origin === 'http://127.0.0.1:5181' ? 'node_fixture' : undefined),
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
    assert.equal(spawned.options.env.DEPLOY_NODE_ID, 'node_fixture');
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
test('the desktop worker names the node this computer joined on the same coordinator only', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-agent-'));
  try {
    const config = join(root, 'agent.json');
    writeFileSync(
      config,
      JSON.stringify({ coordinatorUrl: 'https://deploy.local', nodeId: 'node_mac', secret: 'x' }),
    );
    assert.equal(
      localNodeId('https://deploy.local', [join(root, 'missing.json'), config]),
      'node_mac',
    );
    assert.equal(localNodeId('https://other.local', [config]), undefined);
    writeFileSync(config, 'not json');
    assert.equal(localNodeId('https://deploy.local', [config]), undefined);
  } finally {
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

test('tray uses attention SVG, never literal exclamation text, and shows decision context and age', () => {
  const state = {
    page: 'tray',
    platform: 'darwin',
    online: true,
    name: 'MacBook Pro',
    now: Date.parse('2026-10-27T18:32:00Z'),
    inbox: [{ ...item, text: '4 checks passed', createdAt: '2026-10-27T18:28:00Z' }],
  };
  const model = trayModel(state);
  assert.equal(model.items[0].time, '4m');
  assert.equal(JSON.stringify(model).includes('!'), false);
  const html = render(state);
  assert.equal(html.replace(/<[^>]*>/g, '').includes('!'), false);
  assert.match(html, /<svg class="icon attention"/);
  assert.match(html, /aria-label="Needs you"/);
  assert.match(html, /Scout · 4 checks passed/);
  assert.match(html, /datetime="2026-10-27T18:28:00Z">4m/);
  for (const key of ['⌘N', '⌘O', '⌘Q']) assert.ok(html.includes(key));
  assert.match(render({ ...state, inbox: [] }), /No decisions waiting/);
});

test('tray health dots never add decisions, and missing measurements stay unavailable', () => {
  const state = {
    page: 'tray',
    online: true,
    inbox: [],
    live: {
      summary: { running: 7, failing: 1, warning: 1 },
      computers: [
        {
          apps: [
            { appId: 'immich', name: 'Immich', state: 'warning', summary: 'Memory 92% of 4 GB' },
            {
              appId: 'sync',
              name: 'home-gym sync',
              state: 'failing',
              summary: '38% of jobs error',
            },
            { appId: 'web', name: 'home-gym', state: 'healthy', summary: 'Healthy' },
          ],
        },
      ],
    },
  };
  const model = trayModel(state);
  assert.equal(model.count, 0);
  assert.equal(model.icon, 'failing');
  assert.deepEqual(
    model.apps.map((entry) => entry.label),
    ['Failing', 'High memory'],
  );
  assert.equal(model.computersOnline, undefined);
  assert.equal(
    trayModel({
      live: {
        computers: [{ apps: [{ state: 'warning', summary: 'Memory telemetry unavailable' }] }],
      },
    }).apps[0].label,
    'Warning',
  );
  assert.match(render(state), /class="status failing"><span class="dot"/);
  assert.match(render(state), /class="status warning"><span class="dot"/);
  assert.equal(trayModel({ ...state, online: false }).icon, 'offline');
  assert.equal(trayModel({ online: true, summary: { warning: 1 } }).icon, 'warning');
  assert.equal(trayModel({ online: true, summary: { running: 7 } }).icon, 'connected');
  assert.equal(trayModel({}).running, 'Unavailable');
});

test('Take new tasks changes admission, preserves other roles and never re-enrolls or stops work', async () => {
  const client = new CoordinatorClient('http://127.0.0.1:5184');
  const calls = [];
  const computer = {
    id: 'worker:desktop-fixture',
    workerIds: ['desktop-fixture'],
    roles: ['take-tasks', 'use-screen', 'run-apps'],
    doing: [{ kind: 'task', name: 'Self-release pipeline' }],
  };
  client.request = async (path, options) => {
    calls.push([path, options]);
    return options ? { computer } : { computers: [computer] };
  };
  await client.takeNewTasks('desktop-fixture', false);
  assert.deepEqual(calls[1], [
    '/api/v2/computers/worker%3Adesktop-fixture',
    {
      method: 'PATCH',
      body: { roles: ['use-screen', 'run-apps'] },
    },
  ]);
  assert.equal(calls.length, 2);
  await assert.rejects(client.takeNewTasks('unknown', true), /Join this computer/);
  const html = render({
    page: 'tray',
    online: true,
    workerId: 'desktop-fixture',
    computers: [computer],
  });
  assert.match(html, /Running 1 task/);
  assert.match(html, /Self-release pipeline/);
  assert.match(html, /Current tasks keep running/);
  assert.match(html, /data-action="take-tasks"[^>]*checked/);
  assert.match(
    render({ page: 'tray', online: false, computers: [computer] }),
    /data-action="take-tasks"[^>]*disabled/,
  );
});

test('Live client retains app health rows and computer feature detection does not hide authentication errors', async () => {
  const client = new CoordinatorClient('http://127.0.0.1:5184');
  const live = { summary: { running: 7 }, computers: [{ apps: [{ state: 'failing' }] }] };
  client.request = async () => live;
  assert.deepEqual(await client.live(), live);
  client.request = async () => {
    throw Object.assign(new Error('missing'), { status: 404 });
  };
  assert.equal(await client.computers(), null);
  client.request = async () => {
    throw Object.assign(new Error('sign in'), { status: 401 });
  };
  await assert.rejects(client.computers(), /sign in/);
});

test('non-macOS tray image includes decision digits independently of the state dot', async () => {
  const { icon } = await import('../src/icons.mjs');
  const healthy = icon(40),
    waiting = icon(40, { count: 3 });
  assert.equal(healthy.readUInt32BE(16), 40);
  assert.equal(waiting.readUInt32BE(16), 54);
  assert.equal(icon(40, { count: 100 }).readUInt32BE(16), 82);
  assert.equal(icon(40, { count: 3, failing: true }).readUInt32BE(16), 54);
  assert.notDeepEqual(waiting, icon(40, { count: 3, failing: true }));
  assert.notDeepEqual(healthy, icon(40, { dark: true }));
  assert.deepEqual(healthy, icon(40, { count: -1 }));
});

test('offline uses the coordinator computer name and preserves the running task checkpoint', () => {
  const html = render({
    page: 'offline',
    origin: 'https://deploy.local',
    coordinatorName: 'SER',
    runningTask: { title: 'Self-release pipeline' },
  });
  assert.match(html, /Can't reach SER/);
  assert.match(html, /Your task/);
  assert.match(html, /Paused at its last checkpoint/);
  assert.doesNotMatch(
    render({ page: 'offline', origin: 'https://deploy.local', coordinatorName: 'SER' }),
    /Your task/,
  );
});
