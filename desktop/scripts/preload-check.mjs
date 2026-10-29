import vm from 'node:vm';
import assert from 'node:assert/strict';

export async function verifyPreloads(remote, local) {
  let surface;
  const calls = [],
    exposures = [],
    listens = [];
  const contextBridge = {
    exposeInMainWorld: (name, value) => {
      exposures.push(name);
      surface = value;
    },
  };
  const ipcRenderer = {
    sendSync: () => null,
    on: (channel) => listens.push(channel),
    invoke: (...args) => {
      calls.push(args);
      return Promise.resolve();
    },
  };
  vm.runInNewContext(
    remote,
    {
      require: (name) => {
        assert.equal(name, 'electron');
        return { contextBridge, ipcRenderer };
      },
    },
    { timeout: 1000 },
  );
  assert.deepEqual(exposures, ['deployDesktop']);
  // The page receives the connection state and nothing else; it cannot send on that channel.
  assert.deepEqual(listens, ['desktop:connection']);
  assert.deepEqual(Object.keys(surface).sort(), [
    'control',
    'notify',
    'openExternal',
    'setBadge',
    'worker',
  ]);
  assert.deepEqual(Object.keys(surface.worker).sort(), ['setRoles', 'status']);
  assert.deepEqual(Object.keys(surface.control), ['request']);
  await surface.notify('decision');
  await surface.setBadge(3);
  await surface.worker.status();
  await surface.worker.setRoles({ takeTasks: true });
  await surface.control.request('decision');
  await surface.openExternal('https://example.com');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['desktop:notify', 'decision'],
    ['desktop:badge', 3],
    ['desktop:worker-status'],
    ['desktop:worker-roles', { takeTasks: true }],
    ['desktop:control', 'decision'],
    ['desktop:external', 'https://example.com'],
  ]);
  const globals = {};
  const window = {
    addEventListener: (event, callback) => {
      assert.equal(event, 'DOMContentLoaded');
      callback();
    },
  };
  const shellIpc = {
    ...ipcRenderer,
    on: () => {},
    send: (channel) => assert.equal(channel, 'shell:ready'),
  };
  vm.runInNewContext(
    local,
    {
      require: (name) => {
        assert.equal(name, 'electron');
        return { contextBridge, ipcRenderer: shellIpc };
      },
      document: { addEventListener: () => {} },
      window,
      globalThis: globals,
    },
    { timeout: 1000 },
  );
  assert.deepEqual(exposures, ['deployDesktop']);
  assert.deepEqual(Object.keys(globals), []);
  assert.deepEqual(Object.keys(window), ['addEventListener']);
  return 'Exactly six remote capabilities; no shell page API.';
}
