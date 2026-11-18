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
test('LFS locks: create, conflict, list filters and pages, verify, unlock, force and worker read-only', async () => {
  const { createLock } = await import('./lfs-locks.ts');
  const project = createProject('owner', { name: 'Locked assets' });
  const base = `${origin}/api/git/${project.id}/info/lfs/locks`;
  const call = async (path: string, value?: any, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, {
      method: value === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/vnd.git-lfs+json', ...headers },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    assert.equal(response.headers.get('content-type'), 'application/vnd.git-lfs+json');
    return { status: response.status, body: (await response.json()) as any };
  };
  const created = await call('', { path: 'art/hero.psd', ref: { name: 'refs/heads/main' } });
  assert.equal(created.status, 201);
  const lock = created.body.lock;
  assert.match(lock.id, /^[a-f0-9-]{36}$/);
  assert.equal(lock.path, 'art/hero.psd');
  assert.deepEqual(lock.owner, { name: 'owner' });
  assert.match(lock.locked_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  const conflict = await call('', { path: 'art/hero.psd' });
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.body.lock, lock);
  assert.match(conflict.body.message, /already locked/);
  for (const path of ['', '/abs.psd', '../escape.psd', 'a//b', 7])
    assert.equal((await call('', { path })).status, 422, String(path));
  assert.equal((await call('', { path: 'x', ref: { name: 'main' } })).status, 422);
  // Someone else's lock (owner.name differs) on the same repository.
  const theirs = createLock('owner', project.id, 'teammate', { path: 'audio/theme.wav' }).body.lock;
  assert.equal((await call('')).body.locks.length, 2);
  assert.deepEqual((await call('?path=audio/theme.wav')).body.locks, [theirs]);
  assert.deepEqual((await call('?id=' + lock.id)).body.locks, [lock]);
  assert.deepEqual((await call('?path=missing')).body, { locks: [] });
  assert.equal((await call('?refspec=refs/heads/main')).body.locks.length, 2);
  const first = (await call('?limit=1')).body;
  assert.equal(first.locks.length, 1);
  assert.equal(first.next_cursor, '1');
  const second = (await call('?limit=1&cursor=' + first.next_cursor)).body;
  assert.equal(second.locks.length, 1);
  assert.equal(second.next_cursor, undefined);
  assert.notEqual(first.locks[0].id, second.locks[0].id);
  assert.equal((await call('?cursor=nope')).status, 422);
  // Another repository's locks never leak in.
  const other = createProject('owner', { name: 'Unlocked assets' });
  assert.deepEqual(
    (await (await fetch(`${origin}/api/git/${other.id}/info/lfs/locks`)).json()) as any,
    { locks: [] },
  );
  const verified = await call('/verify', { ref: { name: 'refs/heads/main' } });
  assert.equal(verified.status, 200);
  assert.deepEqual(verified.body, { ours: [lock], theirs: [theirs] });
  const paged = (await call('/verify', { limit: 1 })).body;
  assert.equal(paged.ours.length + paged.theirs.length, 1);
  assert.equal(paged.next_cursor, '1');
  // Workers may read locks of an assigned repository, nothing else.
  save('job', 'owner', {
    id: 'lock-job',
    projectId: project.id,
    workerId: 'worker',
    status: 'running',
  });
  const worker = { 'x-worker': '1' };
  assert.equal((await call('', undefined, worker)).body.locks.length, 2);
  for (const [path, value] of [
    ['', { path: 'new.psd' }],
    ['/verify', {}],
    [`/${lock.id}/unlock`, {}],
    [`/${lock.id}/unlock`, { force: true }],
  ] as const) {
    const refused = await call(path, value, worker);
    assert.equal(refused.status, 403, path);
    assert.match(refused.body.message, /read-only/);
  }
  const notYours = await call(`/${theirs.id}/unlock`, {});
  assert.equal(notYours.status, 403);
  assert.match(notYours.body.message, /locked by teammate/);
  assert.equal((await call(`/${theirs.id}/unlock`, { force: 'yes' })).status, 422);
  assert.deepEqual((await call(`/${theirs.id}/unlock`, { force: true })).body, { lock: theirs });
  assert.deepEqual((await call(`/${lock.id}/unlock`, {})).body, { lock });
  assert.equal((await call(`/${lock.id}/unlock`, {})).status, 404);
  assert.deepEqual((await call('')).body, { locks: [] });
  // The path is free again.
  assert.equal((await call('', { path: 'art/hero.psd' })).status, 201);
});
test('SSH-minted LFS credentials reach one repository, expire, and download cannot upload', async () => {
  const { workspaceRoutes } = await import('../../api/workspace.ts');
  const { mintLfsCredential, lfsCredential, lfsCredentialLifetimeSeconds } =
    await import('./lfs-ssh-credential.ts');
  const routed = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    void workspaceRoutes({
      req,
      res,
      url,
      path: url.pathname,
      method: req.method,
      workspacePath: url.pathname,
    });
  });
  routed.listen(0, '127.0.0.1');
  await once(routed, 'listening');
  const host = `http://127.0.0.1:${(routed.address() as any).port}`;
  try {
    const project = createProject('owner', { name: 'SSH assets' }),
      other = createProject('owner', { name: 'SSH other' });
    const bytes = Buffer.from('ssh lfs object'),
      oid = createHash('sha256').update(bytes).digest('hex');
    const lfs = (id: string) => `${host}/api/git/${id}/info/lfs`;
    const request = (url: string, authorization: string, value?: any, method?: string) =>
      fetch(url, {
        method: method ?? (value === undefined ? 'GET' : 'POST'),
        headers: { Authorization: authorization, 'Content-Type': 'application/vnd.git-lfs+json' },
        body:
          value === undefined
            ? undefined
            : Buffer.isBuffer(value)
              ? new Uint8Array(value)
              : JSON.stringify(value),
      });
    const batch = (operation: string) => ({ operation, objects: [{ oid, size: bytes.length }] });

    const upload = mintLfsCredential('owner', project.id, 'upload');
    assert.equal(upload.expiresIn, lfsCredentialLifetimeSeconds);
    assert.match(upload.authorization, /^RemoteAuth [A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    // Only a digest of the secret is stored.
    const secret = upload.authorization.split('.')[1];
    assert.ok(
      !JSON.stringify(
        db.prepare("SELECT * FROM records WHERE kind='lfs-ssh-credential'").all(),
      ).includes(secret),
    );
    assert.deepEqual(lfsCredential(upload.authorization), {
      owner: 'owner',
      projectId: project.id,
      operation: 'upload',
    });
    const planned: any = await (
      await request(lfs(project.id) + '/objects/batch', upload.authorization, batch('upload'))
    ).json();
    // Transfer actions carry the same credential, so object URLs accept it too.
    assert.deepEqual(planned.objects[0].actions.upload.header, {
      Authorization: upload.authorization,
    });
    assert.equal(
      (await request(lfs(project.id) + '/objects/' + oid, upload.authorization, bytes, 'PUT'))
        .status,
      200,
    );
    const locked = await request(lfs(project.id) + '/locks', upload.authorization, {
      path: 'a.bin',
    });
    assert.equal(locked.status, 201);
    assert.deepEqual(((await locked.json()) as any).lock.owner, { name: 'owner' });
    assert.equal(
      (await request(lfs(project.id) + '/locks/verify', upload.authorization, {})).status,
      200,
    );

    const download = mintLfsCredential('owner', project.id, 'download').authorization;
    assert.equal((await request(lfs(project.id) + '/objects/' + oid, download)).status, 200);
    assert.equal(
      (await request(lfs(project.id) + '/objects/batch', download, batch('download'))).status,
      200,
    );
    assert.equal((await request(lfs(project.id) + '/locks', download)).status, 200);
    for (const [path, value, method] of [
      ['/objects/batch', batch('upload'), undefined],
      ['/objects/' + oid, bytes, 'PUT'],
      ['/locks', { path: 'b.bin' }, undefined],
      ['/locks/verify', {}, undefined],
    ] as const)
      assert.equal(
        (await request(lfs(project.id) + path, download, value, method)).status,
        403,
        path,
      );

    // Scoped to one repository and to LFS: not another repository, not Git itself, not the API.
    assert.equal((await request(lfs(other.id) + '/locks', upload.authorization)).status, 403);
    assert.equal(
      (
        await request(
          `${host}/api/git/${project.id}/info/refs?service=git-upload-pack`,
          upload.authorization,
        )
      ).status,
      403,
    );
    assert.equal((await request(`${host}/api/projects`, upload.authorization)).status, 401);

    // Expired, forged or tampered credentials fall through to ordinary sign-in, which refuses.
    const expired = mintLfsCredential(
      'owner',
      project.id,
      'upload',
      Date.now() - (lfsCredentialLifetimeSeconds + 1) * 1000,
    ).authorization;
    assert.equal(lfsCredential(expired), null);
    for (const authorization of [
      expired,
      upload.authorization.slice(0, -1) + (upload.authorization.endsWith('A') ? 'B' : 'A'),
      'RemoteAuth ' + Buffer.from('other').toString('base64url') + '.' + secret,
      'RemoteAuth nonsense',
    ])
      assert.equal((await request(lfs(project.id) + '/locks', authorization)).status, 401);
  } finally {
    routed.closeAllConnections();
    await new Promise<void>((done) => routed.close(() => done()));
  }
});
