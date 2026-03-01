import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let currentStore: any;

function setup() {
  tempDir = mkdtempSync(join(tmpdir(), 'deploy-sh-test-'));
  process.env.DEPLOY_DATA_DIR = tempDir;
}

function teardown() {
  if (currentStore?._resetDb) currentStore._resetDb();
  currentStore = null;
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(tempDir, { recursive: true, force: true });
}

// Dynamic import so each test suite gets a fresh module with the new cwd
async function loadStore() {
  // Bust the module cache by using a query param
  const id = `../server/store.ts?t=${Date.now()}-${Math.random()}`;
  const mod = await import(id);
  currentStore = mod;
  return mod;
}

describe('store – registerUser', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('registers a new user and returns a token', async () => {
    const store = await loadStore();
    const result = store.registerUser('alice', 'password123');
    assert.ok(result.token);
    assert.equal(typeof result.token, 'string');
    assert.equal(result.token.length, 64); // 32 bytes hex
  });

  it('rejects duplicate username', async () => {
    const store = await loadStore();
    store.registerUser('alice', 'password123');
    const result = store.registerUser('alice', 'other');
    assert.equal(result.error, 'User already exists');
    assert.equal(result.status, 409);
  });
});

describe('store – loginUser', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('logs in with valid credentials', async () => {
    const store = await loadStore();
    store.registerUser('bob', 'secret');
    const result = store.loginUser('bob', 'secret');
    assert.ok(result.token);
    assert.equal(typeof result.token, 'string');
  });

  it('returns a different token on each login', async () => {
    const store = await loadStore();
    const reg = store.registerUser('bob', 'secret');
    const login = store.loginUser('bob', 'secret');
    assert.notEqual(reg.token, login.token);
  });

  it('rejects wrong password', async () => {
    const store = await loadStore();
    store.registerUser('bob', 'secret');
    const result = store.loginUser('bob', 'wrong');
    assert.equal(result.error, 'Invalid credentials');
    assert.equal(result.status, 401);
  });

  it('rejects non-existent user', async () => {
    const store = await loadStore();
    const result = store.loginUser('ghost', 'anything');
    assert.equal(result.error, 'Invalid credentials');
    assert.equal(result.status, 401);
  });
});

describe('store – authenticate', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns true for valid username and token', async () => {
    const store = await loadStore();
    const { token } = store.registerUser('carol', 'pass');
    assert.equal(store.authenticate('carol', token), true);
  });

  it('returns false for wrong token', async () => {
    const store = await loadStore();
    store.registerUser('carol', 'pass');
    assert.equal(store.authenticate('carol', 'badtoken'), false);
  });

  it('returns false for null inputs', async () => {
    const store = await loadStore();
    assert.equal(store.authenticate(null, null), false);
    assert.equal(store.authenticate(undefined, undefined), false);
  });
});

describe('store – logoutUser', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('invalidates the specified session token', async () => {
    const store = await loadStore();
    const { token } = store.registerUser('dave', 'pass');
    assert.equal(store.authenticate('dave', token), true);
    store.logoutUser('dave', token);
    assert.equal(store.authenticate('dave', token), false);
  });

  it('does not invalidate other sessions', async () => {
    const store = await loadStore();
    const { token: token1 } = store.registerUser('dave', 'pass');
    const { token: token2 } = store.loginUser('dave', 'pass');
    assert.equal(store.authenticate('dave', token1), true);
    assert.equal(store.authenticate('dave', token2), true);
    store.logoutUser('dave', token1);
    assert.equal(store.authenticate('dave', token1), false);
    assert.equal(store.authenticate('dave', token2), true);
  });
});

describe('store – concurrent sessions', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('keeps previous session valid after new login', async () => {
    const store = await loadStore();
    const reg = store.registerUser('bob', 'secret');
    const login = store.loginUser('bob', 'secret');
    assert.equal(store.authenticate('bob', reg.token), true);
    assert.equal(store.authenticate('bob', login.token), true);
  });
});

describe('store – changePassword', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('changes password with valid current password', async () => {
    const store = await loadStore();
    store.registerUser('frank', 'oldpass');
    const result = store.changePassword('frank', 'oldpass', 'newpass');
    assert.ok(result.success);
    const login = store.loginUser('frank', 'newpass');
    assert.ok(login.token);
  });

  it('rejects wrong current password', async () => {
    const store = await loadStore();
    store.registerUser('frank', 'oldpass');
    const result = store.changePassword('frank', 'wrongpass', 'newpass');
    assert.equal(result.error, 'Invalid current password');
    assert.equal(result.status, 401);
  });

  it('old password no longer works after change', async () => {
    const store = await loadStore();
    store.registerUser('frank', 'oldpass');
    store.changePassword('frank', 'oldpass', 'newpass');
    const result = store.loginUser('frank', 'oldpass');
    assert.equal(result.error, 'Invalid credentials');
  });
});

describe('store – getUser', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns user info for existing user', async () => {
    const store = await loadStore();
    store.registerUser('eve', 'pass');
    const user = store.getUser('eve');
    assert.equal(user.username, 'eve');
    assert.ok(user.createdAt);
  });

  it('returns null for non-existent user', async () => {
    const store = await loadStore();
    assert.equal(store.getUser('nobody'), null);
  });
});

describe('store – deployment CRUD', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('saves and retrieves a deployment', async () => {
    const store = await loadStore();
    store.saveDeployment({ name: 'myapp', username: 'alice', port: 3001 });
    const d = store.getDeployment('myapp');
    assert.equal(d.name, 'myapp');
    assert.equal(d.username, 'alice');
    assert.equal(d.port, 3001);
    assert.ok(d.updatedAt);
  });

  it('getDeployments filters by username', async () => {
    const store = await loadStore();
    store.saveDeployment({ name: 'app1', username: 'alice', port: 3001 });
    store.saveDeployment({ name: 'app2', username: 'bob', port: 3002 });
    store.saveDeployment({ name: 'app3', username: 'alice', port: 3003 });

    const aliceApps = store.getDeployments('alice');
    assert.equal(aliceApps.length, 2);
    assert.ok(aliceApps.every((d: { username: string }) => d.username === 'alice'));

    const bobApps = store.getDeployments('bob');
    assert.equal(bobApps.length, 1);
    assert.equal(bobApps[0].name, 'app2');
  });

  it('deleteDeployment removes the entry', async () => {
    const store = await loadStore();
    store.saveDeployment({ name: 'myapp', username: 'alice', port: 3001 });
    assert.ok(store.getDeployment('myapp'));
    store.deleteDeployment('myapp');
    assert.equal(store.getDeployment('myapp'), null);
  });

  it('getAllDeployments returns all entries', async () => {
    const store = await loadStore();
    store.saveDeployment({ name: 'a', username: 'x', port: 1 });
    store.saveDeployment({ name: 'b', username: 'y', port: 2 });
    const all = store.getAllDeployments();
    assert.equal(all.length, 2);
  });

  it('getDeployment returns null for non-existent', async () => {
    const store = await loadStore();
    assert.equal(store.getDeployment('nope'), null);
  });
});

describe('store – deployment history', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('records and retrieves history events', async () => {
    const store = await loadStore();
    store.addDeployEvent('myapp', { action: 'deploy', username: 'alice' });
    store.addDeployEvent('myapp', { action: 'restart', username: 'alice' });
    const history = store.getDeployHistory('myapp');
    assert.equal(history.length, 2);
    assert.equal(history[0].action, 'deploy');
    assert.equal(history[1].action, 'restart');
    assert.ok(history[0].timestamp);
  });

  it('returns empty array for app with no history', async () => {
    const store = await loadStore();
    const history = store.getDeployHistory('nope');
    assert.deepEqual(history, []);
  });
});

describe('store – resource metrics', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('logMetrics inserts and getMetricsHistory retrieves', async () => {
    const store = await loadStore();
    const now = Date.now();
    store.logMetrics('myapp', {
      cpuPercent: 5.5,
      memUsageBytes: 1024 * 1024 * 100,
      memLimitBytes: 1024 * 1024 * 1024,
      memPercent: 9.77,
      netRxBytes: 1100,
      netTxBytes: 800,
      blockReadBytes: 5000,
      blockWriteBytes: 3000,
      pids: 12,
      timestamp: now,
    });

    const metrics = store.getMetricsHistory('myapp', now - 1000);
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].cpuPercent, 5.5);
    assert.equal(metrics[0].memUsageBytes, 1024 * 1024 * 100);
    assert.equal(metrics[0].pids, 12);
    assert.equal(metrics[0].timestamp, now);
  });

  it('getMetricsHistory filters by since timestamp', async () => {
    const store = await loadStore();
    const old = Date.now() - 120_000;
    const recent = Date.now();

    const base = {
      cpuPercent: 1,
      memUsageBytes: 100,
      memLimitBytes: 1000,
      memPercent: 10,
      netRxBytes: 0,
      netTxBytes: 0,
      blockReadBytes: 0,
      blockWriteBytes: 0,
      pids: 1,
    };

    store.logMetrics('myapp', { ...base, timestamp: old });
    store.logMetrics('myapp', { ...base, timestamp: recent });

    const all = store.getMetricsHistory('myapp', old - 1000);
    assert.equal(all.length, 2);

    const filtered = store.getMetricsHistory('myapp', old + 1000);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].timestamp, recent);
  });

  it('returns empty array for app with no metrics', async () => {
    const store = await loadStore();
    const metrics = store.getMetricsHistory('nope', 0);
    assert.deepEqual(metrics, []);
  });
});
