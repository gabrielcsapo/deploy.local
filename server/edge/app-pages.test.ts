import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { appNameFromHost, appNotFoundHtml, appUnavailableHtml, closestApp } from './app-pages.ts';
import { availabilityFor, AppStateReader } from './app-state.ts';
import { createHotPathHandler, registerAppPageSource } from './proxy.ts';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

function response() {
  return {
    status: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(status: number, headers: Record<string, string>) {
      this.status = status;
      this.headers = headers;
    },
    end(body = '') {
      this.body = body;
    },
  };
}
const apps = [{ name: 'meal-planner', title: 'Meals for the week' }, { name: 'home-gym' }];
test('unknown deploy.local host offers closest app and an absolute all-apps link', () => {
  const handler = createHotPathHandler({
    getRoute: () => null,
    listApps: () => apps,
    logRequest() {},
    emitEvent() {},
  });
  const res = response();
  assert.equal(
    handler(
      { headers: { host: 'meal-plan.deploy.local' }, url: '/', method: 'GET' } as IncomingMessage,
      res as unknown as ServerResponse,
    ),
    true,
  );
  assert.equal(res.status, 404);
  assert.match(res.body, /Meals for the week/);
  assert.match(res.body, /href="https:\/\/meal-planner.deploy.local\/"/);
  assert.match(res.body, /href="https:\/\/deploy.local\/"/);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});
test('host aliases, closest-match ties and escaping are deterministic', () => {
  assert.equal(appNameFromHost('HOME-GYM.DEPLOY.LOCAL.'), 'home-gym');
  assert.equal(appNameFromHost('home-gym.local'), 'home-gym');
  assert.equal(appNameFromHost('deploy.local'), null);
  assert.equal(appNameFromHost('discover.local'), null);
  assert.equal(appNameFromHost('example.com'), null);
  assert.equal(closestApp('cat', [{ name: 'bat' }, { name: 'car' }])?.name, 'bat');
  assert.doesNotMatch(appNotFoundHtml('<script>', [{ name: 'bad"host' }]), /<script>|bad"host/);
  assert.match(appNotFoundHtml('unknown.deploy.local', []), /Check the address/);
});
test('rolling-back app short-circuits a ready route and sends auto-reload headers', () => {
  let selected = false;
  const handler = createHotPathHandler({
    getRoute: () => ({
      name: 'home-gym',
      port: 5199,
      selectBackend: () => {
        selected = true;
        return null;
      },
    }),
    getAvailability: () => ({
      name: 'home-gym',
      title: 'Workouts',
      state: 'rolling-back',
      computer: 'SER',
    }),
    logRequest() {},
    emitEvent() {},
  });
  for (const method of ['GET', 'HEAD']) {
    const res = response();
    handler(
      { headers: { host: 'home-gym.deploy.local' }, url: '/', method } as IncomingMessage,
      res as unknown as ServerResponse,
    );
    assert.equal(res.status, 503);
    assert.equal(res.headers.Refresh, '5');
    assert.equal(res.headers['Retry-After'], '5');
    if (method === 'GET') {
      assert.match(res.body, /Workouts is being restored/);
      assert.match(res.body, /Rolling back on SER/);
      assert.match(res.body, /http-equiv="refresh"/);
    } else assert.equal(res.body, '');
  }
  assert.equal(selected, false);
});
test('single-process wrappers share registered page metadata and cleanup removes it', () => {
  const dispose = registerAppPageSource({ listApps: () => apps });
  const handler = createHotPathHandler({ getRoute: () => null, logRequest() {}, emitEvent() {} });
  const res = response();
  handler(
    { headers: { host: 'meal-plan.local' }, url: '/', method: 'GET' } as IncomingMessage,
    res as unknown as ServerResponse,
  );
  assert.match(res.body, /Meals for the week/);
  dispose();
});
test('stopped and unavailable pages are honest, self-contained and escape state', () => {
  const html = appUnavailableHtml({ name: '<script>', state: 'stopped', computer: '<SER>' });
  assert.match(html, /There is no return time yet/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|<link|<img|Other apps are running/);
});
const deployment = { name: 'home-gym', username: 'gabriel', status: 'running', computer: 'SER' };
const record = (kind: string, data: object, owner = 'gabriel') => ({
  kind,
  owner,
  data: JSON.stringify(data),
});
const project = record('v2-release', {
  project: { id: 'gym', apps: [{ id: 'home-gym', name: 'Workouts' }] },
});
const rollback = (steps: object[], owner = 'gabriel') =>
  record('v2-rollback', { state: 'running', rollback: { projectId: 'gym', steps } }, owner);
test('availability uses owner-scoped release and Live records and resumes after activate', () => {
  const records = [
    project,
    record('v2-health', { app: { appId: 'home-gym', name: 'Workouts' } }),
    rollback([{ name: 'activate', state: 'running', startedAt: '2026-10-27T18:46:00Z' }]),
  ];
  assert.deepEqual(availabilityFor(deployment, records), {
    name: 'home-gym',
    title: 'Workouts',
    computer: 'SER',
    state: 'rolling-back',
    startedAt: '2026-10-27T18:46:00Z',
  });
  assert.equal(
    availabilityFor(deployment, [
      project,
      rollback([
        { name: 'activate', state: 'done' },
        { name: 'watch', state: 'running' },
      ]),
    ]),
    null,
  );
  assert.equal(
    availabilityFor(deployment, [
      project,
      rollback([{ name: 'activate', state: 'running' }], 'someone-else'),
    ]),
    null,
  );
  assert.equal(availabilityFor({ ...deployment, status: 'stopped' }, [])?.state, 'stopped');
});
test('read-only snapshot reads existing databases without migrating either store', () => {
  const root = mkdtempSync(join(tmpdir(), 'edge-pages-'));
  const file = join(root, 'deploy.db');
  const db = new Database(file);
  db.exec(
    "CREATE TABLE deployments(name,username,status,active_node_id); CREATE TABLE nodes(id,name); INSERT INTO nodes VALUES('ser','SER'); INSERT INTO deployments VALUES('home-gym','gabriel','stopped','ser')",
  );
  mkdirSync(join(root, 'workspace'));
  const workspace = new Database(join(root, 'workspace', 'workspace.db'));
  workspace.exec('CREATE TABLE records(kind,owner,data)');
  const reader = new AppStateReader(file);
  try {
    assert.deepEqual(reader.listApps(), [{ name: 'home-gym' }]);
    assert.equal(reader.getAvailability('home-gym')?.state, 'stopped');
    assert.equal(reader.getAvailability('missing'), null);
  } finally {
    reader.close();
    workspace.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
