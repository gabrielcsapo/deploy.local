import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { apiRouteManifest } from './api/route-manifest.ts';
import { compilePath } from './kernel/routes.ts';
import { operationSignature } from './workspace/operation-signature.ts';
import {
  rewriteManagedGitUrl,
  rewriteManagedGitConfig,
  migrateManagedGitCheckouts,
} from './workspace/git-url-migration.ts';
import { convertStoredAttachments } from '../shared/stored-attachment-urls.ts';

const root = mkdtempSync(join(tmpdir(), 'one-api-'));
process.env.DEPLOY_DATA_DIR = root;
await import('./test-ports.ts');
after(() => rmSync(root, { recursive: true, force: true }));
const oldPrefix = (family: string) => ['', 'api', family, ''].join('/');

test('source strings and served routes contain no retired API prefixes', () => {
  const exceptions = new Map([
    ['shared/stored-attachment-urls.ts', 'Read-time conversion of stored attachment strings only'],
    ['server/workspace/git-url-migration.ts', 'Git remote rewrite'],
    [
      'native/Apple/Packages/DeployKit/Sources/DeployCore/Attachments.swift',
      'Read-time conversion of stored attachment strings only',
    ],
    [
      'native/Apple/Packages/DeployKit/Tests/DeployCoreTests/AttachmentTests.swift',
      'testStoredLinksResolveToNewResourcesWithoutRewritingForeignLinks',
    ],
  ]);
  const violations: string[] = [];
  function scan(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git', '.build'].includes(entry.name) || entry.isSymbolicLink())
        continue;
      const file = join(directory, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (entry.isFile()) {
        if (file.startsWith('native/') && !file.endsWith('.swift')) continue;
        const source = readFileSync(file, 'utf8');
        const normalized = source.replaceAll('\\/', '/');
        if (
          ![oldPrefix('v2'), oldPrefix('workspace')].some((prefix) => normalized.includes(prefix))
        )
          continue;
        const reason = exceptions.get(file);
        if (!reason || !source.includes(reason)) violations.push(file);
      }
    }
  }
  for (const directory of ['app', 'bin', 'desktop', 'server', 'shared', 'packages', 'native/Apple'])
    scan(directory);
  assert.deepEqual(violations, []);
  for (const route of apiRouteManifest) {
    assert.ok(route.path.startsWith('/api/'));
    assert.ok(
      !route.path.startsWith(oldPrefix('v2')) && !route.path.startsWith(oldPrefix('workspace')),
    );
    assert.notEqual(route.path, '/api/:rest*');
  }
});

const matches = (method: string, path: string) =>
  apiRouteManifest.filter((route) => route.method === method && compilePath(route.path)(path));
test('colliding resources have distinct leaves, including the formerly shadowed routes', () => {
  for (const [method, path, handler] of [
    ['GET', '/api/computers', 'v2:v2/computers'],
    ['GET', '/api/computer-roles', 'fleet'],
    ['GET', '/api/worker-permissions', 'workspace'],
    ['POST', '/api/projects', 'v2:v2/projects-api'],
    ['POST', '/api/repository-projects', 'workspace'],
    ['GET', '/api/projects/p/settings', 'v2:v2/settings'],
    ['GET', '/api/projects/p/metadata', 'workspace'],
    ['GET', '/api/activity-events', 'v2:v2/api'],
    ['GET', '/api/events', 'workspace'],
    ['GET', '/api/task-snapshots/t', 'v2:v2/tasks'],
    ['GET', '/api/tasks/t', 'workspace'],
    ['GET', '/api/conversation-attachments/abc', 'v2:v2/attachments'],
    ['GET', '/api/attachments/abc', 'workspace'],
    ['GET', '/api/model-settings', 'v2:v2/computers'],
    ['GET', '/api/release-approval-rules', 'v2:v2/releases-api'],
    ['PUT', '/api/release-approval-rules', 'v2:v2/releases-api'],
    ['GET', '/api/approvals', 'v2:v2/agents'],
    ['POST', '/api/devices', 'v2:v2/push'],
    ['DELETE', '/api/devices', 'v2:v2/push'],
    ['GET', '/api/devices', 'v2:v2/auth'],
    ['GET', '/api/catalog/releases/app/1', 'catalog'],
    ['GET', '/api/catalog/installations/app', 'catalog'],
  ])
    assert.deepEqual(
      matches(method, path).map((route) => route.handler),
      [handler],
      method + ' ' + path,
    );
});

test('operation replay preserves the pre-cut hash and returns converted stored results', async () => {
  const { db, command } = await import('./workspace/store.ts');
  const body = { name: 'project', operationId: 'before-cut' };
  const signature = createHash('sha256')
    .update('/projects' + JSON.stringify(body))
    .digest('hex');
  assert.equal(operationSignature('/repository-projects', body), signature);
  for (const path of ['/tasks/t/messages', '/projects/p/settings', '/workers/enroll'])
    assert.equal(
      operationSignature(path, body),
      createHash('sha256')
        .update(path + JSON.stringify(body))
        .digest('hex'),
    );
  db.prepare('INSERT INTO operations VALUES(?,?,?)').run(
    'owner',
    body.operationId,
    JSON.stringify({
      __workspaceOperation: 1,
      signature,
      result: { ref: oldPrefix('v2') + 'attachments/abc' },
    }),
  );
  assert.deepEqual(
    command(
      'owner',
      body.operationId,
      () => {
        throw new Error('replayed action ran');
      },
      operationSignature('/repository-projects', body),
    ),
    { ref: '/api/conversation-attachments/abc' },
  );
  assert.throws(
    () =>
      command(
        'owner',
        body.operationId,
        () => null,
        operationSignature('/repository-projects', { ...body, name: 'changed' }),
      ),
    /different command/,
  );
});

test('stored records, events and Markdown links convert on read, preserving foreign URLs', async () => {
  const legacy = oldPrefix('workspace') + 'attachments/abc';
  const value = {
    ref: oldPrefix('v2') + 'attachments/abc',
    text: `![media](${legacy}) https://elsewhere.test${legacy}`,
    nested: [legacy],
  };
  const converted = {
    ref: '/api/conversation-attachments/abc',
    text: `![media](/api/attachments/abc) https://elsewhere.test${legacy}`,
    nested: ['/api/attachments/abc'],
  };
  assert.deepEqual(convertStoredAttachments(value), converted);
  const { db, get, list, event, events, eventsBefore } = await import('./workspace/store.ts');
  db.prepare('INSERT INTO records VALUES(?,?,?,?)').run(
    'message',
    'm',
    'owner',
    JSON.stringify(value),
  );
  assert.deepEqual(get('message', 'owner', 'm'), converted);
  assert.deepEqual(list('message', 'owner'), [converted]);
  event('owner', 'task', null, 'message', value);
  assert.deepEqual(events('owner')[0].payload, converted);
  assert.deepEqual(eventsBefore('owner', 999, 'task')[0].payload, converted);
  assert.ok(
    String((db.prepare('SELECT data FROM records WHERE id=?').get('m') as any).data).includes(
      legacy,
    ),
  );
});

test('managed origin, push and LFS URLs migrate once, never foreign remotes or source trees', () => {
  const legacy = oldPrefix('workspace') + 'git/p';
  const origin = 'https://deploy.test';
  const before = `[remote "origin"]\n\turl = ${origin}${legacy}\n\tpushurl = "https://user:token@deploy.test${legacy}"\n[remote "upstream"]\n\turl = https://foreign.test${legacy}\n[lfs]\n\turl = ${origin}${legacy}/info/lfs\n\tpushurl = https://foreign.test${legacy}\n`;
  const after = before
    .replaceAll(`${origin}${legacy}`, `${origin}/api/git/p`)
    .replace(`https://user:token@deploy.test${legacy}`, 'https://user:token@deploy.test/api/git/p');
  assert.equal(rewriteManagedGitConfig(before, [origin]), after);
  assert.equal(rewriteManagedGitConfig(after, [origin]), after);
  assert.equal(rewriteManagedGitUrl(legacy, [origin], true), '/api/git/p');
  assert.equal(
    rewriteManagedGitUrl(legacy, [origin]),
    legacy,
    'a local filesystem remote is not a coordinator URL',
  );
  assert.equal(
    rewriteManagedGitUrl('https://foreign.test' + legacy, [origin]),
    'https://foreign.test' + legacy,
  );
  const managed = resolve(root, 'managed');
  for (const folder of ['repositories/working', 'tasks/t', 'checkpoints/c', 'seeds/s']) {
    mkdirSync(resolve(managed, folder, '.git'), { recursive: true });
    writeFileSync(resolve(managed, folder, '.git/config'), before);
  }
  assert.equal(migrateManagedGitCheckouts(managed, [origin]).length, 4);
  assert.deepEqual(migrateManagedGitCheckouts(managed, [origin]), []);
  for (const folder of ['repositories/working', 'tasks/t', 'checkpoints/c', 'seeds/s'])
    assert.equal(readFileSync(resolve(managed, folder, '.git/config'), 'utf8'), after);
});

test('real leaf dispatch reaches release rules and push devices without opening a socket', async () => {
  const { apiRoutes } = await import('./api/registry.ts');
  const { routeFetch } = await import('./v2/test-request.ts');
  const { registerUser } = await import('./store.ts');
  const { list } = await import('./workspace/store.ts');
  const token = registerUser('route-owner', 'test-password').token!;
  const headers = { 'x-deploy-username': 'route-owner', 'x-deploy-token': token };
  const call = routeFetch(async (req, res) => {
    const url = new URL(req.url!, 'https://deploy.test');
    await apiRoutes({
      req,
      res,
      method: req.method,
      url,
      path: url.pathname,
      workspacePath: url.pathname,
    });
  });
  const get = (path: string) => call('https://deploy.test' + path, { headers });
  const rules = await get('/api/release-approval-rules');
  assert.equal(rules.status, 200);
  assert.ok(Array.isArray((await rules.json()).rules));
  const update = await call('https://deploy.test/api/release-approval-rules', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ rules: [] }),
  });
  assert.equal(update.status, 200);
  const device = { token: 'ab'.repeat(32), environment: 'sandbox' };
  const registered = await call('https://deploy.test/api/devices', {
    method: 'POST',
    headers,
    body: JSON.stringify(device),
  });
  assert.equal(registered.status, 200);
  assert.equal(list('v2-device', 'route-owner').length, 1);
  assert.equal(
    (
      await call('https://deploy.test/api/devices', {
        method: 'DELETE',
        headers,
        body: JSON.stringify(device),
      })
    ).status,
    200,
  );
  assert.equal(list('v2-device', 'route-owner').length, 0);
  assert.equal((await get('/api/worker-permissions')).status, 200);
  assert.equal((await get('/api/model-settings')).status, 200);
  assert.equal((await get('/api/activity-events?after=latest')).status, 200);
  assert.equal((await get('/api/events?after=0')).status, 200);
  for (const prefix of [oldPrefix('v2'), oldPrefix('workspace')])
    assert.equal((await get(prefix + 'events')).status, 404);
  assert.equal(
    (await call('https://deploy.test/api/model-settings', { method: 'DELETE', headers })).status,
    405,
  );
  assert.equal(
    (
      await call('https://deploy.test/api/not-a-resource', {
        method: 'POST',
        headers,
        body: 'not JSON',
      })
    ).status,
    404,
  );
  assert.equal((await call('https://deploy.test/api/model-settings')).status, 401);
  assert.equal(
    (
      await call('https://deploy.test/api/projects', {
        headers: { ...headers, 'x-deploy-worker-token': 'invalid' },
      })
    ).status,
    403,
  );
});

test('startup converts only coordinator project sources and is idempotent', async () => {
  const { db, save, get } = await import('./workspace/store.ts');
  const { migrateCoordinatorUrls } = await import('./workspace/startup-url-migration.ts');
  const oldPath = oldPrefix('workspace') + 'git/project';
  const own = 'https://deploy.local' + oldPath,
    foreign = 'https://elsewhere.test' + oldPath;
  save('project', 'migration-owner', { id: 'own', sourcePath: own, retained: true });
  save('project', 'migration-owner', { id: 'foreign', sourcePath: foreign });
  save('project', 'migration-owner', { id: 'local', sourcePath: '/outside/source' });
  migrateCoordinatorUrls(db, resolve(root, 'no-checkouts'));
  assert.deepEqual(get('project', 'migration-owner', 'own'), {
    id: 'own',
    sourcePath: 'https://deploy.local/api/git/project',
    retained: true,
  });
  assert.equal(get('project', 'migration-owner', 'foreign').sourcePath, foreign);
  assert.equal(get('project', 'migration-owner', 'local').sourcePath, '/outside/source');
  const changes = (db.prepare('SELECT total_changes() AS n').get() as any).n;
  migrateCoordinatorUrls(db, resolve(root, 'no-checkouts'));
  assert.equal((db.prepare('SELECT total_changes() AS n').get() as any).n, changes);
});

// Expand constrained parameters too: one sample per alternative, not just the first action.
function manifestPaths(pattern: string): string[] {
  const segments = pattern.split('/');
  let paths = [''];
  for (const segment of segments.slice(1)) {
    const param = segment.match(/^:([\w]+)(?:\((.+)\)|(\*))?$/);
    let values = [segment];
    if (param) {
      const expression = param[2];
      values = !expression
        ? ['missing']
        : expression === '[a-f0-9]{64}'
          ? ['a'.repeat(64)]
          : expression === '.+\\.git'
            ? ['missing.git']
            : expression.split('|').map((value) => {
                if (value === '\\d+' || value === '[0-9]+') return '1';
                if (/^\[.*\]\+$/.test(value)) return 'abc123';
                return value;
              });
    }
    paths = paths.flatMap((path) => values.map((value) => path + '/' + value));
  }
  for (const path of paths) assert.ok(compilePath(pattern)(path), `${pattern}: ${path}`);
  return paths;
}

async function registryFetch() {
  const { apiRoutes } = await import('./api/registry.ts');
  const { routeFetch } = await import('./v2/test-request.ts');
  return routeFetch((req, res) => {
    const url = new URL(req.url!, 'https://deploy.test');
    return apiRoutes({
      req,
      res,
      url,
      path: url.pathname,
      workspacePath: url.pathname,
      method: req.method,
    });
  });
}

test(
  'every manifest leaf and action ends an unauthenticated request without sockets',
  { timeout: 30000 },
  async () => {
    const call = await registryFetch();
    for (const route of apiRouteManifest) {
      for (const path of manifestPaths(route.path)) {
        const method = route.method === '*' ? 'GET' : route.method;
        const response = await call('https://deploy.test' + path, {
          method,
          ...(['GET', 'HEAD'].includes(method) ? {} : { body: '{}' }),
        });
        assert.ok(
          response.status >= 200 && response.status < 500,
          `${method} ${path}: ${response.status}`,
        );
      }
    }
  },
);

test('standalone dispatch ends unknown requests and delegates other API leaves', async () => {
  const { v2Api } = await import('./v2/api.ts');
  const { requireAuth } = await import('./api/shared.ts');
  const { routeFetch } = await import('./v2/test-request.ts');
  const { registerUser } = await import('./store.ts');
  const token = registerUser('standalone-owner', 'test-password').token!;
  const headers = { 'x-deploy-username': 'standalone-owner', 'x-deploy-token': token };
  const call = routeFetch((req, res) => v2Api(req, res, requireAuth));
  for (const method of ['GET', 'POST', 'DELETE']) {
    assert.equal((await call('https://deploy.test/api/unknown', { method, headers })).status, 404);
  }
  assert.equal(
    (await call('https://deploy.test/api/model-settings', { method: 'DELETE', headers })).status,
    405,
  );
  assert.equal((await call('https://deploy.test/api/user', { headers })).status, 200);
});

test('workspace leaves retain worker authentication, identity fencing and owner-only commands', async () => {
  const call = await registryFetch();
  const { enrollWorker } = await import('./workspace/credentials.ts');
  const { registerUser } = await import('./store.ts');
  const { get } = await import('./workspace/store.ts');
  const owner = 'worker-route-owner';
  const token = registerUser(owner, 'test-password').token!;
  const person = { 'x-deploy-username': owner, 'x-deploy-token': token };
  const credential = enrollWorker(owner, { workerId: 'test-worker' });
  const worker = {
    'x-deploy-worker-id': credential.workerId,
    'x-deploy-worker-token': credential.workerToken,
  };
  const post = (path: string, headers: Record<string, string>, body = {}) =>
    call('https://deploy.test/api' + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      await post('/workers/register', worker, {
        workerId: credential.workerId,
        instanceId: 'test-instance',
      })
    ).status,
    200,
  );
  assert.equal(
    (await post('/workers/test-worker/poll', worker, { instanceId: 'test-instance' })).status,
    200,
  );
  assert.equal((await post('/workers/someone-else/poll', worker)).status, 403);
  assert.equal((await post('/workers/register', worker, { workerId: 'someone-else' })).status, 403);
  for (const path of ['/worker-permissions', '/computers/test-worker/permissions']) {
    assert.equal((await call('https://deploy.test/api' + path, { headers: person })).status, 200);
    assert.equal((await call('https://deploy.test/api' + path, { headers: worker })).status, 403);
  }
  assert.equal(
    (
      await post('/repository-projects', worker, {
        name: 'Forbidden',
        operationId: 'worker-create',
      })
    ).status,
    403,
  );
  const created = await post('/repository-projects', person, {
    name: 'Queued repository',
    operationId: 'owner-create',
  });
  assert.equal(created.status, 202);
  const project = await created.json();
  assert.equal(project.source.kind, 'hosted');
  assert.equal(get('project', owner, project.id).repositoryStatus, 'preparing');
  assert.equal(
    (await call(`https://deploy.test/api/projects/${project.id}/repository`, { headers: person }))
      .status,
    200,
  );
});

test('every route a handler declares is in the manifest, so a new route cannot silently 404', () => {
  // The manifest is an index over the handlers' own tables. A route added to a handler and not
  // to the manifest is never dispatched. Nested tables declare a suffix of the served path, so
  // each declared path must be the tail of some manifest path (parameter names aside).
  const names = (path: string) =>
    path.replace(/:[A-Za-z0-9_]+/g, ':p').replace(/:p\([^)]*\)/g, ':p');
  const manifest = apiRouteManifest.map((route) => names(route.path));
  const sources = [
    'server/workspace/api.ts',
    ...readdirSync('server/v2')
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => 'server/v2/' + file),
  ];
  const missing: string[] = [];
  for (const file of sources)
    for (const match of readFileSync(file, 'utf8').matchAll(/^\s+path: '(\/[^']*)',?$/gm)) {
      // Scope dispatchers hand a subtree to nested tables; their leaves are checked themselves.
      if (match[1].endsWith(':rest*')) continue;
      // The manifest names the only action that has restore steps.
      if (match[1].startsWith('/api/backups/:backup/:action(restore|test)/:restore/')) continue;
      const declared = names(match[1]);
      if (!manifest.some((path) => path === '/api' + declared || path.endsWith(declared)))
        missing.push(`${file}: ${match[1]}`);
    }
  assert.deepEqual(missing, []);
});
