import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { routeFetch } from './test-request.ts';

const root = mkdtempSync(join(tmpdir(), 'v2-diagnostics-'));
process.env.DEPLOY_DATA_DIR = root;
const store = await import('../store.ts');
const { diagnosticsApi, observeRequest, profileSelf, routeName, summarizeProfile } =
  await import('./diagnostics.ts');
after(() => rmSync(root, { recursive: true, force: true }));

test('a route is named without the ids in it', () => {
  assert.equal(
    routeName('GET', '/api/v2/projects/67d679c5-003f-45d0-b424-53a99dbb0149/overview?x=1'),
    'GET /api/v2/projects/:id/overview',
  );
  assert.equal(
    routeName('GET', '/api/v2/projects/app%3Awander/overview'),
    'GET /api/v2/projects/:id/overview',
  );
  assert.equal(
    routeName('POST', '/api/workspace/tasks/42/shell'),
    'POST /api/workspace/tasks/:id/shell',
  );
  assert.equal(routeName('GET', '/api/workspace/state'), 'GET /api/workspace/state');
});

test('a profile is summarised as shares of the time the thread was busy', () => {
  const frame = (functionName: string, url = '', lineNumber = 0) => ({
    functionName,
    url,
    lineNumber,
    columnNumber: 0,
  });
  const summary = summarizeProfile({
    startTime: 0,
    endTime: 1000,
    nodes: [
      { id: 1, callFrame: frame('(root)'), children: [2, 3] },
      { id: 2, callFrame: frame('(idle)') },
      { id: 3, callFrame: frame('handler', 'file:///srv/dist/server.js', 9), children: [4] },
      { id: 4, callFrame: frame('parse') },
    ],
    samples: [2, 3, 4, 4],
    timeDeltas: [600, 100, 150, 150],
  });
  assert.equal(summary.busyPercent, 40);
  assert.deepEqual(summary.self[0], { percent: 75, functionName: 'parse', where: '' });
  assert.deepEqual(summary.inclusive[0], {
    percent: 100,
    functionName: 'handler',
    where: 'dist/server.js:10:1',
  });
});

test('profiling records what the thread did and which requests arrived, one profile at a time', async () => {
  const taking = profileSelf(0.4);
  await assert.rejects(profileSelf(0.1), /already being taken/);
  const response = new EventEmitter();
  observeRequest({ method: 'GET' } as any, response as any, '/api/v2/projects/12345/overview');
  const until = Date.now() + 120;
  while (Date.now() < until) JSON.parse(JSON.stringify({ busy: 'x'.repeat(2000) }));
  response.emit('close');
  const { summary, profile } = await taking;
  assert.ok(profile.samples.length > 0);
  assert.ok(summary.busyPercent > 0);
  assert.equal(summary.routes[0].route, 'GET /api/v2/projects/:id/overview');
  assert.equal(summary.routes[0].count, 1);
  // Nothing is recorded once the profile is over.
  const later = new EventEmitter();
  observeRequest({ method: 'GET' } as any, later as any, '/api/v2/live');
  later.emit('close');
  assert.equal((await profileSelf(0.05)).summary.routes.length, 0);
});

test('only an administrator can profile, and the length is bounded', async () => {
  // The first account on a server is its administrator.
  await store.registerUser('first-admin', 'password-password');
  await store.registerUser('someone-else', 'password-password');
  assert.equal(store.isAdmin('first-admin'), true);
  assert.equal(store.isAdmin('someone-else'), false);
  const admin = routeFetch((req, res) => diagnosticsApi(req, res, 'first-admin'));
  const other = routeFetch((req, res) => diagnosticsApi(req, res, 'someone-else'));
  await assert.rejects(other('http://x/api/v2/diagnostics/profile?seconds=1', { method: 'POST' }), {
    status: 403,
  });
  {
    await assert.rejects(
      admin('http://x/api/v2/diagnostics/profile?seconds=900', { method: 'POST' }),
      {
        status: 400,
      },
    );
    const ok = await admin('http://x/api/v2/diagnostics/profile?seconds=1', { method: 'POST' });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.ok(body.summary.samples > 0);
    assert.equal(body.profile, undefined);
  }
  assert.equal((await admin('http://x/api/v2/diagnostics/profile')).status, 405);
});
