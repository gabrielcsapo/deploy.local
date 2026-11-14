import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
const data = mkdtempSync(join(tmpdir(), 'deploy-lfs-test-'));
process.env.DEPLOY_DATA_DIR = data;
const { workspaceApi } = await import('../../workspace/api.ts');
const { createProject } = await import('../../workspace/test-repository.ts');
const { gitText } = await import('../../workspace/repository-git.ts');
const { save, db } = await import('../../workspace/store.ts');
const { hydrateLfs } = await import('./lfs-checkout.ts');
const { pipelineSource } = await import('../../workspace/pipeline-deployment.ts');
const { gunzipSync } = await import('node:zlib');
const server = createServer(
  (req, res) =>
    void workspaceApi(
      req,
      res,
      String(req.headers['x-owner'] || 'owner'),
      req.headers['x-worker'] ? 'worker' : undefined,
    ),
);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  db.close();
  rmSync(data, { recursive: true, force: true });
});
test('LFS validates content, isolates owners/projects, and limits workers to assigned downloads', async () => {
  const project = createProject('owner', { name: 'Assets' }),
    other = createProject('owner', { name: 'Other' });
  const bytes = Buffer.from('binary\0asset'),
    oid = createHash('sha256').update(bytes).digest('hex');
  const base = `${origin}/api/git/${project.id}/info/lfs`;
  const json = (value: any, headers = {}) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/vnd.git-lfs+json', ...headers },
    body: JSON.stringify(value),
  });
  const batch = { operation: 'upload', objects: [{ oid, size: bytes.length }] };
  const first: any = await (await fetch(base + '/objects/batch', json(batch))).json();
  assert.equal(first.objects[0].actions.upload.href, base + '/objects/' + oid);
  assert.equal(
    (await fetch(base + '/objects/' + oid, { method: 'PUT', body: 'wrong' })).status,
    422,
  );
  assert.equal((await fetch(base + '/objects/' + oid)).status, 404);
  assert.equal((await fetch(base + '/objects/' + oid, { method: 'PUT', body: bytes })).status, 200);
  assert.equal((await fetch(base + '/verify', json({ oid, size: bytes.length }))).status, 200);
  assert.deepEqual(Buffer.from(await (await fetch(base + '/objects/' + oid)).arrayBuffer()), bytes);
  const repeated: any = await (await fetch(base + '/objects/batch', json(batch))).json();
  assert.equal(repeated.objects[0].actions, undefined);
  assert.equal(
    (await fetch(base + '/objects/' + oid, { headers: { 'x-owner': 'other' } })).status,
    404,
  );
  assert.equal((await fetch(base.replace(project.id, other.id) + '/objects/' + oid)).status, 404);
  assert.equal(
    (await fetch(base + '/objects/' + oid, { headers: { 'x-worker': '1' } })).status,
    403,
  );
  save('job', 'owner', {
    id: 'assigned',
    projectId: project.id,
    workerId: 'worker',
    status: 'running',
  });
  assert.equal(
    (await fetch(base + '/objects/' + oid, { headers: { 'x-worker': '1' } })).status,
    200,
  );
  assert.equal(
    (await fetch(base + '/objects/batch', json(batch, { 'x-worker': '1' }))).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + '/objects/' + oid, {
        method: 'PUT',
        body: bytes,
        headers: { 'x-worker': '1' },
      })
    ).status,
    403,
  );
});
test(
  'real Git LFS client uploads and clones assets over hosted Git HTTP',
  { skip: spawnSync('git', ['lfs', 'version']).status !== 0 },
  async () => {
    const source = join(data, 'real-lfs');
    mkdirSync(source);
    const git = (...args: string[]) => gitText(source, args);
    await git('init', '--initial-branch=main');
    await git('config', 'user.name', 'Test');
    await git('config', 'user.email', 'test@example.invalid');
    await git('-c', 'core.hooksPath=.git/hooks', 'lfs', 'install', '--local', '--skip-smudge');
    await git('lfs', 'track', '*.bin');
    const bytes = Buffer.from('large asset\0'.repeat(10000));
    writeFileSync(join(source, 'texture.bin'), bytes);
    await git('add', '.');
    await git('commit', '-m', 'Asset');
    const project = createProject('owner', { name: 'LFS client', sourcePath: source });
    const remote = `${origin}/api/git/${project.id}`;
    await git('remote', 'add', 'hosted', remote);
    await git('lfs', 'push', '--all', 'hosted');
    const clone = join(data, 'clone');
    await git('clone', remote, clone);
    await gitText(clone, ['-c', 'core.hooksPath=.git/hooks', 'lfs', 'install', '--local']);
    await gitText(clone, ['lfs', 'pull']);
    assert.equal(readFileSync(join(clone, 'texture.bin')).length, bytes.length);
    assert.ok(readFileSync(join(clone, 'texture.bin')).equals(bytes));
    const commit = await git('rev-parse', 'HEAD');
    const published = gunzipSync((await pipelineSource(project.repositoryPath, commit)).body);
    assert.ok(published.includes(bytes));
    const native = join(data, 'native-checkout');
    await git('clone', project.repositoryPath, native);
    await hydrateLfs(native, project.repositoryPath);
    assert.ok(readFileSync(join(native, 'texture.bin')).equals(bytes));
    assert.equal(
      await gitText(native, ['status', '--porcelain']),
      '',
      await gitText(native, ['diff', '--', 'texture.bin']),
    );
    const remoteWorker = join(data, 'http-checkout');
    await git('clone', remote, remoteWorker);
    save('job', 'owner', {
      id: 'lfs-job',
      projectId: project.id,
      workerId: 'worker',
      status: 'running',
    });
    await hydrateLfs(remoteWorker, remote, { authentication: { origin, header: 'x-worker: 1' } });
    assert.ok(readFileSync(join(remoteWorker, 'texture.bin')).equals(bytes));
    const oid = createHash('sha256').update(bytes).digest('hex');
    rmSync(join(project.repositoryPath, 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid));
    await assert.rejects(
      pipelineSource(project.repositoryPath, commit),
      /requires the pinned Git LFS object/,
    );
    const missing = join(data, 'missing-asset');
    await git('clone', project.repositoryPath, missing);
    await assert.rejects(hydrateLfs(missing, project.repositoryPath), /ENOENT/);
    assert.match(readFileSync(join(missing, 'texture.bin'), 'utf8'), /^version https:\/\/git-lfs/);
  },
);
