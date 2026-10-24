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
const { workspaceApi } = await import('./api.ts');
const { get, save } = await import('./store.ts');
const { git } = await import('./service.ts');
const { repositorySource, queueProject, repositoryCommand } = await import('./repositories.ts');
const { RepositoryRunner } = await import('./repository-runner.ts');
const { gitText } = await import('./repository-git.ts');
const server = createServer((req, res) => {
  const owner = req.headers['x-test-owner'] === 'bob' ? 'bob' : 'alice';
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
  const response = await fetch(origin + '/api/workspace' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: `test-${++op}`, ...body }),
  });
  return { status: response.status, body: (await response.json()) as any };
}
async function read(path: string, owner = 'alice') {
  const response = await fetch(origin + '/api/workspace' + path, {
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
  const created = await post('/projects', {
    operationId: 'import-once',
    name: 'Native project',
    sourcePath: source,
  });
  assert.equal(created.status, 202);
  assert.ok(Date.now() - start < 1000);
  const project = created.body;
  assert.equal(
    (
      await post('/projects', {
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
  const cloned = join(data, 'clone');
  await gitText(data, ['clone', `${origin}/api/workspace/git/${project.id}`, cloned]);
  // The advertised clone path ends in the repository name, so a plain `git clone` names the
  // folder after the repository; the id alone still selects it.
  assert.match(
    info.clonePath,
    new RegExp(`/api/workspace/git/${project.id}/[A-Za-z0-9._-]+\\.git$`),
  );
  const folder = info.clonePath
    .split('/')
    .at(-1)
    .replace(/\.git$/, '');
  const namedRoot = join(data, 'named');
  mkdirSync(namedRoot, { recursive: true });
  await gitText(namedRoot, ['clone', `${origin}${info.clonePath}`]);
  assert.equal(readFileSync(join(namedRoot, folder, 'README.md'), 'utf8'), 'original\n');
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
  await gitText(data, ['clone', `${origin}/api/workspace/git/${project.id}`, remoteCopy]);
  await gitText(remoteCopy, ['fetch', 'origin', remoteTask.sourceRef]);
  assert.equal(git(remoteCopy, ['rev-parse', 'FETCH_HEAD']), remoteTask.baseRevision);
});

test('empty source initializes without altering upstream; failures retry and cancellation is durable', async () => {
  const empty = join(data, 'empty');
  mkdirSync(empty);
  git(empty, ['init', '--bare']);
  const created = await post('/projects', { name: 'Empty', sourcePath: empty });
  const info = (await ready(created.body.id)).body;
  assert.equal(info.defaultBranch, 'main');
  assert.equal(git(empty, ['for-each-ref']), '');
  const bad = await post('/projects', { name: 'Missing', sourcePath: join(data, 'missing') });
  await until(
    () => read(`/projects/${bad.body.id}/repository`),
    (r) => r.body.operation.status === 'failed',
  );
  assert.equal((await post(`/projects/${bad.body.id}/repository/retry`)).body.status, 'queued');
  await until(
    () => read(`/projects/${bad.body.id}/repository`),
    (r) => r.body.operation.status === 'failed',
  );
  const slow = await post('/projects', { name: 'Cancel', sourcePath: empty });
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
  const project = (await post('/projects', { name: 'Queued workspace', sourcePath: source })).body;
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
    const task = (await post('/tasks', { projectId: project.id, title: 'First prompt' })).body;
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
