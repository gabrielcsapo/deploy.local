import { apiRouteManifest } from '../api/route-manifest.ts';
import { compilePath } from '../kernel/routes.ts';
import assert from 'node:assert/strict';
import test, { after, mock } from 'node:test';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { routeFetch } from './test-request.ts';

const root = mkdtempSync(join(tmpdir(), 'read-views-'));
process.env.DEPLOY_DATA_DIR = root;
await import('../test-backups.ts');
process.env.DEPLOY_RELEASE_CONFIG = join(root, 'release.json');
const repo = join(root, 'repo');
mkdirSync(join(repo, 'design/boards'), { recursive: true });
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.test',
    },
  }).trim();
git('init', '-b', 'main');
writeFileSync(
  join(repo, 'deploy.yaml'),
  'apiVersion: deploy.local/v1\nkind: Application\nmetadata:\n  name: web\ncomponents:\n  web:\n    image: example/web\n',
);
writeFileSync(
  join(repo, 'design/canvas.json'),
  JSON.stringify({
    title: 'Test',
    boards: { 'Welcome.html': { title: 'Welcome', x: 0, y: 0, w: 1440, h: 900 } },
    order: ['Welcome.html'],
    notes: {},
  }),
);
writeFileSync(join(repo, 'design/boards/Welcome.html'), '<h1 data-layer="title">Welcome</h1>');
git('add', '.');
git('commit', '-m', 'First');
const first = git('rev-parse', 'HEAD');
writeFileSync(join(repo, 'other.txt'), 'Second');
git('add', '.');
git('commit', '-m', 'Second');
const main = git('rev-parse', 'HEAD');
git('checkout', '-b', 'design/welcome');
writeFileSync(join(repo, 'design/boards/Welcome.html'), '<h1 data-layer="title">Hello</h1>');
git('commit', '-am', 'Design');
const proposal = git('rev-parse', 'HEAD');
git('checkout', 'main');
git('checkout', '-b', 'artifact/plan');
mkdirSync(join(repo, 'artifacts/plan'), { recursive: true });
writeFileSync(join(repo, 'artifacts/plan/document.md'), '# Plan\n\nOne server.\n');
git('add', '.');
git('commit', '-m', 'Plan');
const documentProposal = git('rev-parse', 'HEAD');
git('checkout', 'main');
const current = join(root, 'current');
mkdirSync(current);
writeFileSync(join(current, '.deploy-release.json'), JSON.stringify({ revision: first }));
writeFileSync(
  process.env.DEPLOY_RELEASE_CONFIG,
  JSON.stringify({
    user: 'test',
    uid: 1,
    releases: root,
    current,
    data: root,
    node: process.execPath,
  }),
);
const stateDir = join(root, 'self-update');
mkdirSync(stateDir);
const run = {
  id: 'update-test',
  from: first,
  to: main,
  state: 'running',
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  startedBy: 'owner',
  steps: [{ id: 'prepare', state: 'running', detail: 'Starting' }],
};
writeFileSync(join(stateDir, 'current.json'), JSON.stringify(run));

const store = await import('../store.ts');
const workspace = await import('../workspace/store.ts');
const { v2Api } = await import('./api.ts');
const { workspaceApi } = await import('../workspace/api.ts');
store.registerUser('owner', 'test-password');
workspace.save('project', 'owner', {
  id: 'p',
  owner: 'owner',
  name: 'deploy.local',
  repositoryPath: repo,
  repositoryStatus: 'ready',
  defaultBranch: 'main',
});
store.saveDeployment({ name: 'web', username: 'owner' });
workspace.save('task', 'owner', {
  id: 't',
  projectId: 'p',
  title: 'A task',
  status: 'ready',
  revision: 1,
});
workspace.save('pull-request', 'owner', {
  id: 'pr',
  projectId: 'p',
  taskIds: ['t'],
  number: 1,
  title: 'A pull',
  status: 'open',
  sourceBranch: 'design/welcome',
  targetBranch: 'main',
});
workspace.save('v2-inbox-native', 'owner', {
  id: 'review',
  item: {
    id: 'review',
    title: 'Welcome design',
    state: 'waiting',
    createdAt: new Date().toISOString(),
  },
  context: {
    source: 'design',
    projectId: 'p',
    main: 'main',
    branch: 'design/welcome',
    base: main,
    commit: proposal,
    paths: ['design/boards/Welcome.html'],
    taskId: 't',
    summary: 'Welcome',
  },
});
// A document's review that was already decided: its page still reads Before and After.
workspace.save('v2-inbox-native', 'owner', {
  id: 'document-review',
  item: {
    id: 'document-review',
    title: 'Plan',
    state: 'answered',
    createdAt: new Date().toISOString(),
    actions: [{ id: 'approve', label: 'Approve document' }],
  },
  context: {
    source: 'design',
    projectId: 'p',
    folder: 'artifacts/plan',
    main: 'main',
    branch: 'artifact/plan',
    base: main,
    commit: documentProposal,
    paths: ['artifacts/plan/document.md'],
  },
});
const fetch = routeFetch((req, res) =>
  apiRouteManifest.some(
    (r) =>
      r.handler === 'workspace' &&
      r.method === req.method &&
      compilePath(r.path)(new URL(req.url!, 'http://localhost').pathname),
  )
    ? workspaceApi(req, res, 'owner')
    : v2Api(req, res, () => ({ username: 'owner' })),
);
async function request(path: string) {
  const response = await fetch(`http://localhost${path}`);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}
// Count every process boundary used by the helpers, including sync Git and exec's shell.
let starts: string[] = [];
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec'] as const) {
  const original = childProcess[name];
  mock.method(childProcess, name, (...args: any[]) => {
    starts.push(`${name}: ${args[0]} ${Array.isArray(args[1]) ? args[1].join(' ') : ''}`);
    return Reflect.apply(original, childProcess, args);
  });
}
syncBuiltinESMExports();
after(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  workspace.db.close();
  store._resetDb();
  rmSync(root, { recursive: true, force: true });
});

const paths = [
  '/api/projects',
  '/api/projects/p/overview',
  '/api/task-snapshots/t',
  '/api/design/projects',
  '/api/projects/p/design',
  '/api/self-update',
  '/api/updates',
  '/api/backups',
  '/api/projects/p/pulls',
  '/api/projects/p/releases',
  '/api/projects/p/settings',
  '/api/projects/unlinked-apps',
  '/api/projects/p/repository',
  '/api/design/reviews',
  '/api/projects/p/artifacts/plan/document?review=document-review',
];
for (const path of paths)
  test(`warm GET ${path} starts no child process`, async (t) => {
    await request(path);
    starts = [];
    const result = await request(path);
    t.diagnostic(`second request processes: ${starts.length}`);
    assert.deepEqual(starts, [], starts.join('\n'));
    if (path.endsWith('/task-snapshots/t'))
      assert.deepEqual(result.comparison, { ahead: 1, behind: 0 });
    if (path === '/api/self-update') assert.equal(result.ahead, 1);
    if (path === '/api/design/reviews') assert.equal(result.proposals.length, 1);
    if (path.includes('/document?review=')) {
      assert.match(result.text, /One server/);
      assert.equal(result.main, null);
    }
    starts = [];
    await request(path);
    assert.deepEqual(starts, [], 'first request after warm-up also reuses the view');
  });

test('update progress stays live while service probing is cached', async () => {
  await request('/api/self-update');
  writeFileSync(
    join(stateDir, 'current.json'),
    JSON.stringify({
      ...run,
      startedAt: new Date().toISOString(),
      steps: [{ id: 'prepare', state: 'running', detail: 'Building now' }],
    }),
  );
  starts = [];
  assert.equal((await request('/api/self-update')).run.steps[0].detail, 'Building now');
  assert.deepEqual(starts, []);
});

test('a ref moved by the server or by another process is seen on the next read', async () => {
  const { gitText } = await import('../git.ts');
  const overview = '/api/projects/p/overview';
  assert.equal((await request(overview)).repository.head, main);
  await gitText(repo, ['update-ref', 'refs/heads/main', proposal, main]);
  assert.equal((await request(overview)).repository.head, proposal);
  // A process that does not use our Git helpers sends no notification, but it rewrites the
  // ref's file, and the views notice that without starting Git.
  git('update-ref', 'refs/heads/main', main, proposal);
  assert.equal((await request(overview)).repository.head, main);
});

test('project, deployment and membership writes stay live after warm-up', async () => {
  await request('/api/projects');
  workspace.save('project', 'owner', {
    ...workspace.get('project', 'owner', 'p'),
    name: 'Renamed',
  });
  assert.equal(
    (await request('/api/projects')).projects.find((p: any) => p.id === 'p').name,
    'Renamed',
  );
  store.saveDeployment({ name: 'second', username: 'owner' });
  assert.ok(
    (await request('/api/projects/unlinked-apps')).apps.some((app: any) => app.name === 'second'),
  );
  const { addProjectApplication } = await import('./projects.ts');
  await addProjectApplication('owner', 'p', 'second');
  assert.ok(
    (await request('/api/projects')).projects
      .find((p: any) => p.id === 'p')
      .apps.some((app: any) => app.name === 'second'),
  );
  assert.ok(
    !(await request('/api/projects/unlinked-apps')).apps.some((app: any) => app.name === 'second'),
  );
});

test('all shared Git write helpers invalidate views, including a worktree and failed partial writes', async () => {
  const helpers = await import('../git.ts');
  const { presentationCommit } = await import('../workspace/repository-views.ts');
  const writers = [
    helpers.gitText,
    helpers.gitRead,
    helpers.gitString,
    helpers.gitSync,
    helpers.gitStringSync,
  ];
  for (const write of writers) {
    assert.equal(await presentationCommit(repo, 'refs/heads/main'), main);
    await write(repo, ['update-ref', 'refs/heads/main', proposal, main]);
    assert.equal(await presentationCommit(repo, 'refs/heads/main'), proposal);
    await write(repo, ['update-ref', 'refs/heads/main', main, proposal]);
    assert.equal(await presentationCommit(repo, 'refs/heads/main'), main);
  }
  const worktree = join(root, 'task-worktree');
  await helpers.gitText(repo, ['worktree', 'add', '-b', 'task/new', worktree, main]);
  await helpers.gitText(worktree, ['update-ref', 'refs/heads/main', proposal, main]);
  assert.equal(
    await presentationCommit(repo, 'refs/heads/main'),
    proposal,
    'a worktree write invalidates the shared repository',
  );
  // The command fails, but its pre/post invalidation still removes observations from before it.
  git('update-ref', 'refs/heads/main', main, proposal);
  await assert.rejects(helpers.gitText(repo, ['update-ref', 'refs/heads/main', main, proposal]));
  assert.equal(await presentationCommit(repo, 'refs/heads/main'), main);
});

test('transaction and decision helpers bypass a warm view', async () => {
  const { commitText, presentationCommit } = await import('../workspace/repository-views.ts');
  const { repositoryInfo } = await import('../workspace/repositories.ts');
  const { changesSince } = await import('./self-update-host.ts');
  await request('/api/projects/p/overview');
  await commitText(repo, ['rev-parse', '--verify', `${main}^{tree}`]);
  git('update-ref', 'refs/heads/main', proposal, main);
  // The view has already noticed the move; what a transaction adds is that it asks Git itself.
  assert.equal(await presentationCommit(repo, 'refs/heads/main'), proposal);
  starts = [];
  let transactionRead!: Promise<string>;
  workspace.db.transaction(() => {
    transactionRead = presentationCommit(repo, 'refs/heads/main');
  })();
  assert.equal(await transactionRead, proposal);
  assert.ok(starts.length > 0);
  starts = [];
  let transactionObject!: Promise<string>;
  workspace.db.transaction(() => {
    transactionObject = commitText(repo, ['rev-parse', '--verify', `${main}^{tree}`]);
  })();
  await transactionObject;
  assert.ok(starts.length > 0, 'even immutable reads bypass views inside a transaction');
  const direct = await repositoryInfo('owner', 'p');
  assert.ok('head' in direct);
  assert.equal(direct.head, proposal);
  assert.equal(
    (await changesSince(repo, first)).main,
    proposal,
    'updater decision uses current Git',
  );
  git('update-ref', 'refs/heads/main', main, proposal);
});

test('same-process sync notifications refresh refs and changing review choices recomputes evidence', async () => {
  const overview = '/api/projects/p/overview';
  await request(overview);
  git('update-ref', 'refs/heads/main', proposal, main);
  workspace.save('repository-operation', 'owner', {
    id: 'sync',
    projectId: 'p',
    status: 'succeeded',
  });
  assert.equal((await request(overview)).repository.head, proposal);
  await request('/api/design/reviews');
  const review = workspace.get('v2-inbox-native', 'owner', 'review');
  workspace.save('v2-inbox-native', 'owner', {
    ...review,
    context: {
      ...review.context,
      choices: { 'Welcome.html': { main: proposal, proposal, choice: 'main' } },
    },
  });
  starts = [];
  await request('/api/design/reviews');
  assert.ok(starts.length > 0, 'saved choices never reuse evidence computed for older choices');
  const { gitText } = await import('../git.ts');
  await gitText(repo, ['update-ref', 'refs/heads/main', main, proposal]);
});

test('an unborn task branch uses its base without starting Git again, and appears immediately when written', async () => {
  workspace.save('task', 'owner', {
    id: 'unborn',
    projectId: 'p',
    title: 'New',
    status: 'ready',
    revision: 1,
    baseRevision: first,
  });
  const path = '/api/projects/p/design?task=unborn';
  assert.equal((await request(path)).commit, first);
  starts = [];
  assert.equal((await request(path)).commit, first);
  assert.deepEqual(starts, []);
  const { currentTaskBranch } = await import('../workspace/follow-up.ts');
  const { gitText } = await import('../git.ts');
  const branch = currentTaskBranch(workspace.get('task', 'owner', 'unborn'));
  await gitText(repo, ['update-ref', `refs/heads/${branch}`, proposal]);
  assert.equal((await request(path)).commit, proposal);
});

test('immutable object reads preserve bytes and limits, survive ref moves, and return isolated buffers', async () => {
  const { commitBytes, commitText, optionalCommitText } =
    await import('../workspace/repository-views.ts');
  const { gitText } = await import('../git.ts');
  const args = ['show', `${main}:deploy.yaml`];
  const bytes = await commitBytes(repo, args);
  assert.ok(bytes.toString().endsWith('\n'));
  const original = Buffer.from(bytes);
  await optionalCommitText(repo, args, undefined, false);
  bytes.fill(0);
  starts = [];
  assert.deepEqual(await commitBytes(repo, args), original);
  assert.equal(await commitText(repo, args, undefined, false), original.toString());
  assert.equal(await optionalCommitText(repo, args, undefined, false), original.toString());
  assert.equal(await commitText(repo, args), original.toString().trimEnd());
  assert.deepEqual(starts, []);
  await gitText(repo, ['update-ref', 'refs/heads/main', proposal, main]);
  starts = [];
  assert.deepEqual(await commitBytes(repo, args), original);
  assert.deepEqual(starts, [], 'ref invalidation preserves immutable objects');
  await assert.rejects(commitBytes(repo, args, { limit: 1 }), /size limit/);
  await gitText(repo, ['update-ref', 'refs/heads/main', main, proposal]);
});

test('design landing records invalidate their project through the review context', async () => {
  const path = '/api/projects/p/overview';
  assert.equal((await request(path)).repository.head, main);
  git('update-ref', 'refs/heads/main', proposal, main);
  workspace.save('design-review-landing', 'owner', {
    id: 'review',
    state: 'landed',
    commit: proposal,
  });
  assert.equal((await request(path)).repository.head, proposal);
  const { gitText } = await import('../git.ts');
  await gitText(repo, ['update-ref', 'refs/heads/main', main, proposal]);
});
