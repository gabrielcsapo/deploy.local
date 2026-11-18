import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const data = mkdtempSync(join(tmpdir(), 'deploy-repositories-'));
process.env.DEPLOY_DATA_DIR = data;
process.env.DEPLOY_CODEX_BIN = '/no-codex-in-this-test';
process.env.DEPLOY_CLAUDE_BIN = '/no-claude-in-this-test';
await import('../../test-ports.ts');
const { workspaceApi, shortGitRoute } = await import('../../workspace/api.ts');
const { get, save } = await import('../../workspace/store.ts');
const { git } = await import('../../workspace/service.ts');
const {
  repositorySource,
  queueProject,
  repositoryCommand,
  repositoryAtAddress,
  updateProjectSettings,
  queueDueSyncs,
  repositoryArchiveName,
} = await import('./repositories.ts');
const { repositoryFolderName } = await import('../../../shared/repository-address.ts');
const { RepositoryRunner } = await import('./repository-runner.ts');
const { gitText } = await import('../../workspace/repository-git.ts');
const server = createServer((req, res) => {
  const owner = req.headers['x-test-owner'] === 'bob' ? 'bob' : 'alice';
  // Mirrors the control server: short clone addresses are served as the hosted Git route.
  const short = shortGitRoute(req.url!, req.method);
  if (short?.redirect) return void res.writeHead(301, { Location: short.redirect }).end();
  if (short) req.url = short.url;
  void workspaceApi(req, res, owner);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
// Delay clones in the isolated repository service, not in the API process.
const bin = join(data, 'bin');
mkdirSync(bin);
const actualGit = (await import('node:child_process'))
  .spawnSync('which', ['git'], { encoding: 'utf8' })
  .stdout.trim();
writeFileSync(
  join(bin, 'git'),
  `#!/usr/bin/env node\nconst {spawn}=require('node:child_process'); const a=process.argv.slice(2);setTimeout(()=>{const c=spawn(${JSON.stringify(actualGit)},a,{stdio:'inherit'});c.on('exit',code=>process.exit(code||0));},(a.includes('clone')||a.includes('worktree'))?1500:0);`,
);
chmodSync(join(bin, 'git'), 0o755);
const worker = spawn(process.execPath, [resolve('server/workspace/repository-worker.ts')], {
  env: { ...process.env, PATH: bin + ':' + process.env.PATH },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let workerOutput = '';
worker.stdout.on('data', (d) => (workerOutput += d));
worker.stderr.on('data', (d) => (workerOutput += d));
after(async () => {
  const done = once(worker, 'exit');
  worker.kill('SIGTERM');
  await done;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(data, { recursive: true, force: true });
});
let op = 0;
async function post(path: string, body: any = {}) {
  const response = await fetch(origin + '/api' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: `test-${++op}`, ...body }),
  });
  return { status: response.status, body: (await response.json()) as any };
}
async function read(path: string, owner = 'alice') {
  const response = await fetch(origin + '/api' + path, {
    headers: { 'x-test-owner': owner },
  });
  return { status: response.status, body: (await response.json()) as any };
}
async function until(fn: () => Promise<any>, predicate: (x: any) => boolean, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await fn();
    if (predicate(result)) return result;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Timed out: ' + workerOutput);
}
async function ready(id: string) {
  return until(
    () => read(`/projects/${id}/repository`),
    (r) => r.body.status === 'ready',
  );
}
function sourceRepo(name: string) {
  const path = join(data, name);
  mkdirSync(path);
  git(path, ['init', '--initial-branch=main']);
  git(path, ['config', 'user.name', 'Test']);
  git(path, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(path, 'README.md'), 'original\n');
  git(path, ['add', '.']);
  git(path, ['commit', '-m', 'Initial source']);
  return path;
}

test('durable import stays responsive, preserves dirty source and isolates authority; browsing pins source and HTTP push works', async () => {
  // Process startup is independent of API readiness; wait for its actual heartbeat.
  await until(
    () => read('/repositories/setup'),
    (result) => result.body.ready === true,
  );
  const source = sourceRepo('source');
  const original = git(source, ['rev-parse', 'HEAD']);
  writeFileSync(join(source, 'README.md'), 'dirty source\n');
  const start = Date.now();
  const created = await post('/repository-projects', {
    operationId: 'import-once',
    name: 'Native project',
    sourcePath: source,
  });
  assert.equal(created.status, 202);
  assert.ok(Date.now() - start < 1000);
  const project = created.body;
  assert.equal(
    (
      await post('/repository-projects', {
        operationId: 'import-once',
        name: 'Native project',
        sourcePath: source,
      })
    ).body.id,
    project.id,
  );
  assert.equal((await post('/tasks', { projectId: project.id })).status, 409);
  const stateStart = Date.now();
  assert.equal((await read('/state')).status, 200);
  assert.ok(Date.now() - stateStart < 1000);
  const setup = (await read('/repositories/setup')).body;
  assert.equal(setup.ready, true);
  assert.ok(setup.storage.availableBytes > 0);
  const info = (await ready(project.id)).body;
  assert.equal(info.source.authority, 'deploy.local');
  assert.equal(info.head, original);
  assert.equal(info.serviceOnline, true);
  assert.equal(readFileSync(join(source, 'README.md'), 'utf8'), 'dirty source\n');
  assert.equal((await read(`/projects/${project.id}/repository`, 'bob')).status, 404);
  const tree = (await read(`/projects/${project.id}/repository/tree`)).body;
  assert.equal(tree.commit, original);
  assert.equal(tree.entries[0].name, 'README.md');
  assert.equal(tree.entries[0].size, Buffer.byteLength('original\n'));
  assert.equal(tree.entries[0].lastCommit.revision, original);
  assert.ok(tree.entries[0].lastCommit.subject);
  assert.ok(Number.isFinite(Date.parse(tree.entries[0].lastCommit.date)));
  const blob = (
    await read(`/projects/${project.id}/repository/blob?ref=${original}&path=README.md`)
  ).body;
  assert.equal(blob.content, 'original\n');
  // Download ZIP: the commit as a ZIP, named after the repository and the ref, owner-only.
  const zip = await fetch(
    `${origin}/api/projects/${project.id}/repository/archive?ref=${original}`,
    {
      headers: { 'x-test-owner': 'alice' },
    },
  );
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  const zipName = repositoryArchiveName(project.name, original, original);
  assert.equal(zip.headers.get('content-disposition'), `attachment; filename="${zipName}.zip"`);
  const zipBody = Buffer.from(await zip.arrayBuffer());
  assert.equal(zipBody.subarray(0, 4).toString('latin1'), 'PK\x03\x04');
  assert.ok(zipBody.includes(`${zipName}/README.md`));
  const otherOwner = await fetch(`${origin}/api/projects/${project.id}/repository/archive`, {
    headers: { 'x-test-owner': 'bob' },
  });
  assert.equal(otherOwner.status, 404);
  const cloned = join(data, 'clone');
  await gitText(data, ['clone', `${origin}/api/git/${project.id}`, cloned]);
  // The advertised clone path is the short address `/<repo>.git`, so a plain `git clone` names
  // the folder after the repository.
  assert.equal(info.clonePath, `/${repositoryFolderName(project.name)}.git`);
  const folder = info.clonePath
    .split('/')
    .at(-1)
    .replace(/\.git$/, '');
  const namedRoot = join(data, 'named');
  mkdirSync(namedRoot, { recursive: true });
  await gitText(namedRoot, ['clone', `${origin}${info.clonePath}`]);
  assert.equal(readFileSync(join(namedRoot, folder, 'README.md'), 'utf8'), 'original\n');
  // Like GitHub, the page address clones too: no `.git` suffix, any casing.
  await gitText(namedRoot, ['clone', `${origin}/${folder.toLowerCase()}`, 'page-address']);
  assert.equal(readFileSync(join(namedRoot, 'page-address', 'README.md'), 'utf8'), 'original\n');
  const browser = await fetch(`${origin}${info.clonePath}`, { redirect: 'manual' });
  assert.equal(browser.status, 301);
  assert.equal(browser.headers.get('location'), `/${folder}`);
  git(cloned, ['config', 'user.name', 'Test']);
  git(cloned, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(cloned, 'new.txt'), 'hosted\n');
  writeFileSync(join(cloned, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(cloned, 'large.txt'), 'x'.repeat(256 * 1024 + 1));
  git(cloned, ['add', '.']);
  git(cloned, ['commit', '-m', 'Hosted change']);
  await gitText(cloned, ['push', 'origin', 'HEAD:main']);
  assert.equal(
    (await read(`/projects/${project.id}/repository/blob?path=binary.bin`)).body.omitted,
    'Binary file',
  );
  assert.match(
    (await read(`/projects/${project.id}/repository/blob?path=large.txt`)).body.omitted,
    /preview limit/,
  );
  assert.equal(git(source, ['rev-parse', 'HEAD']), original);
  const pinned = await post('/tasks', {
    projectId: project.id,
    ref: original,
    title: 'Pinned source',
  });
  assert.equal(pinned.status, 202, JSON.stringify(pinned.body));
  await until(
    () => read(`/tasks/${pinned.body.id}`),
    (result) => result.body.task.workspaceStatus === 'ready',
  );
  assert.equal(pinned.body.baseRevision, original);
  assert.equal(readFileSync(join(pinned.body.workspacePath, 'README.md'), 'utf8'), 'original\n');
  assert.equal(existsSync(join(pinned.body.workspacePath, 'new.txt')), false);
  assert.equal(
    (await read(`/projects/${project.id}/repository/history`)).body.commits[0].subject,
    'Hosted change',
  );
  assert.match(
    (await read(`/projects/${project.id}/repository/diff?base=${original}`)).body.patch,
    /hosted/,
  );
  assert.equal(
    (await read(`/projects/${project.id}/repository/blob?ref=${original}&path=README.md`)).body
      .content,
    'original\n',
  );
  const beforeFetch = (await read(`/projects/${project.id}/repository`)).body.head;
  writeFileSync(join(source, 'README.md'), 'upstream\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'Upstream change']);
  const fetched = await post(`/projects/${project.id}/repository/fetch`);
  assert.equal(fetched.body.status, 'queued');
  await until(
    () => read(`/projects/${project.id}/repository`),
    (r) => r.body.operation.status === 'succeeded' && r.body.operation.id === fetched.body.id,
  );
  const updated = (await read(`/projects/${project.id}/repository`)).body;
  assert.equal(updated.head, beforeFetch);
  assert.ok(
    updated.refs.some(
      (ref: any) =>
        ref.name === 'refs/remotes/upstream/main' && ref.oid === git(source, ['rev-parse', 'HEAD']),
    ),
  );
  assert.equal((await read(`/projects/${project.id}/repository/blob?path=../config`)).status, 400);
  assert.equal((await read(`/projects/${project.id}/repository/tree?ref=--all`)).status, 400);
  assert.equal((await read(`/git/${project.id}/HEAD`)).status, 404);
  await post('/workers/register', {
    workerId: 'pinned-remote',
    name: 'Pinned remote',
    codex: true,
  });
  const remoteTask = (
    await post('/tasks', {
      projectId: project.id,
      workerId: 'pinned-remote',
      ref: 'refs/remotes/upstream/main',
    })
  ).body;
  assert.equal(remoteTask.baseRevision, git(source, ['rev-parse', 'HEAD']));
  const remoteCopy = join(data, 'pinned-remote-clone');
  await gitText(data, ['clone', `${origin}/api/git/${project.id}`, remoteCopy]);
  await gitText(remoteCopy, ['fetch', 'origin', remoteTask.sourceRef]);
  assert.equal(git(remoteCopy, ['rev-parse', 'FETCH_HEAD']), remoteTask.baseRevision);
});

test('empty source initializes without altering upstream; failures retry and cancellation is durable', async () => {
  const empty = join(data, 'empty');
  mkdirSync(empty);
  git(empty, ['init', '--bare']);
  const created = await post('/repository-projects', { name: 'Empty', sourcePath: empty });
  const info = (await ready(created.body.id)).body;
  assert.equal(info.defaultBranch, 'main');
  assert.equal(git(empty, ['for-each-ref']), '');
  const bad = await post('/repository-projects', {
    name: 'Missing',
    sourcePath: join(data, 'missing'),
  });
  await until(
    () => read(`/projects/${bad.body.id}/repository`),
    (r) => r.body.operation.status === 'failed',
  );
  assert.equal((await post(`/projects/${bad.body.id}/repository/retry`)).body.status, 'queued');
  await until(
    () => read(`/projects/${bad.body.id}/repository`),
    (r) => r.body.operation.status === 'failed',
  );
  const slow = await post('/repository-projects', { name: 'Cancel', sourcePath: empty });
  await until(
    () => read(`/projects/${slow.body.id}/repository`),
    (r) => r.body.operation.status === 'running',
  );
  await post(`/projects/${slow.body.id}/repository/cancel`);
  const cancelled = await until(
    () => read(`/projects/${slow.body.id}/repository`),
    (r) => r.body.operation.status === 'cancelled',
  );
  assert.equal(cancelled.body.status, 'failed');
  assert.equal(existsSync(slow.body.repositoryPath), false);
});

test('restart requires explicit retry; atomic prepared storage can be recovered without replacing it', async () => {
  const project = queueProject('recovery', { name: 'Recovery' });
  const operation = get('repository-operation', 'recovery', project.repositoryOperationId);
  save('repository-operation', 'recovery', { ...operation, status: 'running' });
  const runner = new RepositoryRunner();
  runner.recover();
  assert.equal(get('repository-operation', 'recovery', operation.id).status, 'unknown');
  assert.equal(get('project', 'recovery', project.id).repositoryStatus, 'unknown');
  // Isolate this record from the running service until its next poll: retry is synchronous and immediately claimed here.
  repositoryCommand('recovery', project.id, 'retry');
  await runner.tick();
  assert.equal(get('project', 'recovery', project.id).repositoryStatus, 'ready');
  const prepared = get('project', 'recovery', project.id);
  const completed = get('repository-operation', 'recovery', prepared.repositoryOperationId);
  const head = git(prepared.repositoryPath, ['rev-parse', 'HEAD']);
  save('repository-operation', 'recovery', {
    ...completed,
    status: 'running',
    gitPid: process.pid,
  });
  save('project', 'recovery', { ...prepared, repositoryStatus: 'preparing' });
  runner.recover();
  assert.throws(() => repositoryCommand('recovery', project.id, 'retry'), /still alive/);
  save('repository-operation', 'recovery', {
    ...get('repository-operation', 'recovery', completed.id),
    gitPid: null,
  });
  repositoryCommand('recovery', project.id, 'retry');
  await runner.tick();
  assert.equal(get('project', 'recovery', project.id).repositoryStatus, 'ready');
  assert.equal(git(prepared.repositoryPath, ['rev-parse', 'HEAD']), head);
});

test('sources reject credentials and helpers before persisting anything', () => {
  for (const source of [
    'https://user:secret@example.com/repo.git',
    'https://host/repo?token=secret',
    'ext::sh -c bad',
    'relative/path',
    'file:///tmp/repo',
    '-upload-pack=bad',
  ])
    assert.throws(() => repositorySource(source));
  assert.equal(repositorySource('git@example.com:team/repo.git').kind, 'remote');
  assert.equal(repositorySource('ssh://git@example.com/team/repo.git').kind, 'remote');
});

test('task preparation accepts a first message, fences execution, and can recover queued cancellation', async () => {
  const source = sourceRepo('queued-source');
  const project = (
    await post('/repository-projects', { name: 'Queued workspace', sourcePath: source })
  ).body;
  await ready(project.id);
  const binary = join(data, 'fixture-agent');
  writeFileSync(
    binary,
    `#!${process.execPath}\nconst fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{const text=fs.readFileSync('README.md','utf8');console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));});`,
  );
  chmodSync(binary, 0o755);
  const local = spawn(process.execPath, [resolve('server/workspace/worker.ts')], {
    env: { ...process.env, DEPLOY_CODEX_BIN: binary },
    stdio: 'ignore',
  });
  try {
    const start = Date.now();
    const task = (
      await post('/tasks', {
        projectId: project.id,
        title: 'First prompt',
        workerId: 'local',
      })
    ).body;
    assert.ok(Date.now() - start < 1000);
    const run = (await post(`/tasks/${task.id}/messages`, { revision: 0, content: 'Read README' }))
      .body;
    const preparing = await until(
      () => read(`/tasks/${task.id}`),
      (result) => result.body.preparation.status === 'running',
    );
    assert.equal(preparing.body.task.workspaceStatus, 'preparing');
    assert.equal(get('run', 'alice', run.id).status, 'queued');
    assert.equal((await read(`/tasks/${task.id}/diff`)).body.status, 'Workspace preparing');
    await until(
      async () => get('run', 'alice', run.id),
      (result) => result.status === 'succeeded',
    );
    const complete = (await read(`/tasks/${task.id}`)).body;
    assert.equal(complete.messages.at(-1).content, 'original\n');
    assert.equal(complete.task.workspaceStatus, 'ready');
    const cancelled = (await post('/tasks', { projectId: project.id, title: 'Cancel preparation' }))
      .body;
    const cancellation = await post(`/tasks/${cancelled.id}/workspace/cancel`);
    assert.equal(cancellation.body.cancelRequested, true);
    await until(
      () => read(`/tasks/${cancelled.id}`),
      (result) => result.body.preparation.status === 'cancelled',
    );
    // This queued cancellation has created no files, so retry can prepare the same task.
    const retry = await post(`/tasks/${cancelled.id}/workspace/retry`);
    assert.equal(retry.body.status, 'queued');
    await until(
      () => read(`/tasks/${cancelled.id}`),
      (result) => result.body.task.workspaceStatus === 'ready',
    );
    await post('/workers/register', {
      workerId: 'remote-repo-test',
      name: 'Remote test',
      codex: true,
    });
    const remote = await post('/tasks', {
      projectId: project.id,
      workerId: 'remote-repo-test',
      title: 'Remote source',
    });
    assert.equal(remote.status, 200);
    assert.equal(existsSync(remote.body.workspacePath), false);
    assert.equal(remote.body.baseRevision, git(source, ['rev-parse', 'HEAD']));
  } finally {
    const done = once(local, 'exit');
    local.kill('SIGTERM');
    await done;
  }
});

test('repositories get short addresses that pages and other repositories cannot shadow', () => {
  const owner = 'addresses';
  const gym = queueProject(owner, { name: 'Home Gym' });
  assert.equal(repositoryAtAddress(owner, 'home-gym')?.id, gym.id);
  assert.equal(repositoryAtAddress(owner, 'HOME-GYM')?.id, gym.id);
  assert.throws(
    () => queueProject(owner, { name: 'home-gym' }),
    /"Home Gym" already uses deploy\.local\/home-gym/,
  );
  for (const name of ['Docs', 'api', 'dashboard', '_next', 'logo.svg', 'tool.git'])
    assert.throws(() => queueProject(owner, { name }), /reserved/, name);
  const other = queueProject(owner, { name: 'Lego Builder' });
  assert.throws(
    () =>
      updateProjectSettings(owner, other.id, {
        name: 'home gym',
        description: '',
        settingsRevision: 0,
      }),
    /already uses/,
  );
  // A rename keeps the old address for links and remotes made before it, until reused.
  updateProjectSettings(owner, gym.id, { name: 'Gym Log', description: '', settingsRevision: 0 });
  assert.equal(repositoryAtAddress(owner, 'gym-log')?.id, gym.id);
  assert.equal(repositoryAtAddress(owner, 'Home-Gym')?.id, gym.id);
  const reused = queueProject(owner, { name: 'Home Gym' });
  assert.equal(repositoryAtAddress(owner, 'home-gym')?.id, reused.id);
  assert.equal(repositoryAtAddress(owner, 'missing'), null);
});

test('a hosted repository starts empty and syncs both ways with a remote, pausing when main changed on both sides', async () => {
  const created = await post('/repository-projects', { name: 'Recipes' });
  assert.equal(created.body.source.kind, 'hosted');
  const info = (await ready(created.body.id)).body;
  assert.equal(info.empty, true);
  assert.equal(info.sync, null);
  const id = created.body.id;
  const repo = created.body.repositoryPath;
  const remote = join(data, 'recipes-remote.git');
  git(data, ['init', '--bare', '--initial-branch=main', remote]);
  // Folders only fetch, so make this local remote stand in for a two-way one.
  const added = await post(`/projects/${id}/repository/remote`, {
    sourcePath: remote,
  });
  assert.equal(added.body.source.syncPolicy, 'manual-fetch');
  assert.equal(
    (await post(`/projects/${id}/repository/remote`, { sourcePath: remote })).status,
    409,
  );
  await until(
    () => read(`/projects/${id}/repository`),
    (r) => r.body.operation?.kind === 'fetch' && r.body.operation.status === 'succeeded',
  );
  assert.equal(git(remote, ['for-each-ref']), '', 'fetch only never pushes');
  save('project', 'alice', {
    ...get('project', 'alice', id),
    source: { ...added.body.source, kind: 'remote', syncPolicy: 'both-ways' },
  });
  const sync = async () => {
    const operation = (await post(`/projects/${id}/repository/fetch`)).body;
    assert.equal(operation.kind, 'sync');
    return (
      await until(
        () => read(`/projects/${id}/repository`),
        (r) =>
          r.body.operation?.id === operation.id &&
          r.body.operation.status !== 'queued' &&
          r.body.operation.status !== 'running',
      )
    ).body;
  };
  // An empty remote receives main.
  let state = await sync();
  assert.equal(state.sync.state, 'in-sync');
  assert.equal(git(remote, ['rev-parse', 'main']), git(repo, ['rev-parse', 'main']));
  // Commits pushed to the remote arrive.
  const clone = join(data, 'recipes-clone');
  git(data, ['clone', remote, clone]);
  git(clone, ['config', 'user.name', 'Test']);
  git(clone, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(clone, 'README.md'), 'from the remote\n');
  git(clone, ['add', '.']);
  git(clone, ['commit', '-m', 'From the remote']);
  git(clone, ['push', 'origin', 'main']);
  state = await sync();
  assert.equal(state.sync.state, 'in-sync');
  assert.equal(state.empty, false);
  assert.equal(git(repo, ['rev-parse', 'main']), git(clone, ['rev-parse', 'HEAD']));
  // Both sides move: nothing is pushed or overwritten.
  writeFileSync(join(clone, 'README.md'), 'remote again\n');
  git(clone, ['commit', '-am', 'Remote again']);
  git(clone, ['push', 'origin', 'main']);
  const here = join(data, 'recipes-here');
  git(data, ['clone', repo, here]);
  git(here, ['config', 'user.name', 'Test']);
  git(here, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(here, 'NOTES.md'), 'here\n');
  git(here, ['add', '.']);
  git(here, ['commit', '-m', 'Here']);
  git(here, ['push', 'origin', 'main']);
  const [localMain, remoteMain] = [
    git(repo, ['rev-parse', 'main']),
    git(remote, ['rev-parse', 'main']),
  ];
  state = await sync();
  assert.equal(state.sync.state, 'paused');
  assert.equal(git(repo, ['rev-parse', 'main']), localMain);
  assert.equal(git(remote, ['rev-parse', 'main']), remoteMain);
  // Two-way repositories are due every five minutes, or after a merge asks.
  const paused = get('project', 'alice', id);
  queueDueSyncs(Date.parse(paused.sync.at) + 1000);
  assert.equal(get('project', 'alice', id).repositoryOperationId, paused.repositoryOperationId);
  queueDueSyncs(Date.parse(paused.sync.at) + 5 * 60 * 1000);
  const due = get('project', 'alice', id).repositoryOperationId;
  assert.notEqual(due, paused.repositoryOperationId);
  assert.equal(get('repository-operation', 'alice', due).kind, 'sync');
});

test('an existing repository pushes to a new project over HTTP without pulling or forcing', async () => {
  const created = await post('/repository-projects', { name: 'Existing' });
  assert.equal((await ready(created.body.id)).body.empty, true);
  const repo = created.body.repositoryPath;
  const work = join(data, 'existing-work');
  git(data, ['init', '--initial-branch=main', work]);
  git(work, ['config', 'user.name', 'Test']);
  git(work, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(work, 'README.md'), 'already written\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-m', 'Existing work']);
  git(work, ['remote', 'add', 'origin', `${origin}/api/git/${created.body.id}`]);
  await gitText(work, ['push', '-u', 'origin', 'main']);
  assert.equal(git(repo, ['log', '--format=%s', 'main']), 'Existing work');
  assert.equal(git(repo, ['for-each-ref', '--format=%(refname)']), 'refs/heads/main');
  assert.equal(git(repo, ['symbolic-ref', 'HEAD']), 'refs/heads/main');
  const info = await until(
    () => read(`/projects/${created.body.id}/repository`),
    (r) => r.body.empty === false,
  );
  assert.equal(info.body.empty, false);
});

test('remotes given with a new project sync both ways; earlier remotes and folders only fetch', () => {
  const owner = 'sync-policy';
  const remote = queueProject(owner, {
    name: 'Remote',
    sourcePath: 'git@example.invalid:x/y.git',
  });
  assert.equal(remote.source.syncPolicy, 'both-ways');
  repositoryCommand(owner, remote.id, 'cancel');
  const folder = queueProject(owner, {
    name: 'Folder',
    sourcePath: join(data, 'nowhere'),
  });
  assert.equal(folder.source.syncPolicy, 'manual-fetch');
  repositoryCommand(owner, folder.id, 'cancel');
  assert.equal(repositorySource('git@example.invalid:x/y.git').syncPolicy, 'manual-fetch');
});

test('a ZIP is named after the repository and the branch, tag or short commit', () => {
  const commit = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  assert.equal(repositoryArchiveName('forma', 'main', commit), 'forma-main');
  assert.equal(repositoryArchiveName('forma', 'refs/tags/v1.2', commit), 'forma-v1.2');
  assert.equal(
    repositoryArchiveName('forma', 'feature/csv export', commit),
    'forma-feature-csv-export',
  );
  assert.equal(repositoryArchiveName('forma', 'HEAD', commit), 'forma-a1b2c3d');
  assert.equal(repositoryArchiveName('forma', commit, commit), 'forma-a1b2c3d');
});

test('the default branch can be any existing branch; it moves HEAD and what releases follow', async () => {
  const created = await post('/repository-projects', { name: 'Branches' });
  await ready(created.body.id);
  const id = created.body.id;
  const repo = created.body.repositoryPath;
  const work = join(data, 'branches-work');
  git(data, ['clone', repo, work]);
  git(work, ['config', 'user.name', 'Test']);
  git(work, ['config', 'user.email', 'test@example.invalid']);
  git(work, ['checkout', '-b', 'develop']);
  writeFileSync(join(work, 'deploy.yaml'), 'name: branches\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-m', 'Develop']);
  git(work, ['push', 'origin', 'develop', 'develop:task/abcd1234']);

  let listed = await read(`/projects/${id}/repository/branches`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.defaultBranch, 'main');
  assert.deepEqual(
    listed.body.branches.map((branch: any) => branch.name),
    ['main', 'develop'],
    'the default comes first and task branches are left out',
  );
  assert.ok(Date.parse(listed.body.branches[1].committedAt));
  assert.equal((await read(`/projects/${id}/repository/branches`, 'bob')).status, 404);

  assert.equal((await post(`/projects/${id}/repository/default-branch`, {})).status, 400);
  assert.equal(
    (await post(`/projects/${id}/repository/default-branch`, { branch: 'task/abcd1234' })).status,
    400,
  );
  const missing = await post(`/projects/${id}/repository/default-branch`, { branch: 'nope' });
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /nope is not a branch/);

  const changed = await post(`/projects/${id}/repository/default-branch`, { branch: 'develop' });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body, { defaultBranch: 'develop' });
  assert.equal(git(repo, ['symbolic-ref', 'HEAD']), 'refs/heads/develop');
  assert.equal(get('project', 'alice', id).defaultBranch, 'develop');
  assert.equal(git(repo, ['rev-parse', 'main']), git(work, ['rev-parse', 'main']), 'main stays');
  const info = (await read(`/projects/${id}/repository`)).body;
  assert.equal(info.defaultBranch, 'develop');
  assert.equal(info.deployment.branch, 'develop');
  assert.equal(info.deployment.commit, git(work, ['rev-parse', 'develop']));
  listed = await read(`/projects/${id}/repository/branches`);
  assert.deepEqual(
    listed.body.branches.map((branch: any) => branch.name),
    ['develop', 'main'],
  );
  // A clone now checks out the new default.
  const fresh = join(data, 'branches-fresh');
  git(data, ['clone', repo, fresh]);
  assert.equal(git(fresh, ['branch', '--show-current']), 'develop');
});
