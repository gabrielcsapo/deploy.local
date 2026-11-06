import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'pipeline-packages-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_MDNS_ADDRESS = '127.0.0.1';
const { registerUser, _resetDb } = await import('../store.ts');
const { db, get, save, list, now } = await import('../workspace/store.ts');
const { pipelineStart, reconcilePipelines, pipelineRead } =
  await import('../workspace/pipelines.ts');
const { advancePipelinePackages } = await import('./pipelines.ts');
const { createNpmRegistry } = await import('./npm.ts');
const { packageByName, versions } = await import('./store.ts');
const { issuePipelinePackageToken, pipelinePackageIdentity } = await import('./pipeline-auth.ts');
const { mergingPackages } = await import('./pipeline-read.ts');
const { finishPackageJob } = await import('../workspace/package-publish.ts');
const { setPackageHooks } = await import('../workspace/package-hooks.ts');
const { jobCommand } = await import('../workspace/coordination.ts');
const { JobRunner } = await import('../workspace/job-runner.ts');
registerUser('owner', 'pipeline-test-password');
registerUser('someone', 'pipeline-test-password');
const upstream = createServer((req, res) => {
  if (req.url?.startsWith('/public-name'))
    res.end(
      JSON.stringify({
        name: 'public-name',
        versions: {
          '1.0.0': {
            name: 'public-name',
            version: '1.0.0',
            dist: {
              tarball: `http://127.0.0.1:${(upstream.address() as any).port}/public-name/-/public-name-1.0.0.tgz`,
            },
          },
        },
      }),
    );
  else {
    res.writeHead(404);
    res.end('{}');
  }
});
await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
const server = createServer((req, res) => {
  void registry.handle(req, res);
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
const registry = createNpmRegistry({
  upstreamBase: `http://127.0.0.1:${(upstream.address() as any).port}/`,
  publicBase: origin + '/npm/',
});
after(async () => {
  registry.copy.close();
  for (const s of [server, upstream]) {
    s.closeAllConnections();
    await new Promise<void>((done) => s.close(() => done()));
  }
  db.close();
  _resetDb();
  await rm(root, { recursive: true, force: true });
});
async function fixture(paths = ['packages/a', 'packages/b']) {
  const id = randomUUID(),
    source = join(root, id);
  await mkdir(source);
  const git = (args: string[]) => exec('git', ['-C', source, ...args]).then((r) => r.stdout.trim());
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Fixture']);
  await git(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(
    join(source, 'deploy.yaml'),
    `apiVersion: deploy.local/v1\nkind: Application\npipeline:\n  on: [push, pull_request]\n  branches: [main]\n  jobs:\n    test:\n      run: node --version\n      runsOn: {os: linux}\n      container: node:26\n  publish: ${JSON.stringify(paths)}\n`,
  );
  for (const path of paths) {
    await mkdir(join(source, path), { recursive: true });
    await writeFile(
      join(source, path, 'package.json'),
      JSON.stringify({
        name: '@deploy.local/' + id + '-' + path.split('/').at(-1),
        version: '1.0.0',
        scripts: { prepublishOnly: "node -e \"require('fs').writeFileSync('built.txt','built')\"" },
      }),
    );
  }
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({ name: 'fixture', private: true, packageManager: 'pnpm@11.1.3' }),
  );
  await writeFile(join(source, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  await git(['add', '.']);
  await git(['commit', '-m', 'Package fixture']);
  const commit = await git(['rev-parse', 'HEAD']);
  const project = save('project', 'owner', {
    id,
    owner: 'owner',
    name: 'fixture',
    repositoryPath: source,
    defaultBranch: 'main',
    repositoryStatus: 'ready',
  });
  return { project, source, git, commit, paths };
}
async function start(f: Awaited<ReturnType<typeof fixture>>, input = {}) {
  return pipelineStart(
    'owner',
    f.project.id,
    { operationId: randomUUID(), ...input },
    randomUUID(),
  );
}
function pass(run: any, status = 'succeeded') {
  for (const job of list('job', 'owner').filter(
    (j) => j.pipelineId === run.id && !j.packagePublish,
  ))
    save('job', 'owner', { ...job, status });
  reconcilePipelines();
}
function claim(run: any) {
  const item = get('pipeline-run', 'owner', run.id).packages.items.find(
    (item: any) => item.jobId && item.status === 'running',
  );
  const job = get('job', 'owner', item.jobId);
  return save('job', 'owner', {
    ...job,
    status: 'running',
    workerId: 'test',
    generation: randomUUID(),
    instanceId: 'test',
  });
}
async function packed(f: Awaited<ReturnType<typeof fixture>>, job: any) {
  const folder = join(f.source, job.packagePublish.path),
    destination = join(folder, job.packagePublish.destination);
  await mkdir(destination, { recursive: true });
  // Real pnpm packing; neither npmrc nor ambient credentials may enter a test.
  const env = {
    ...process.env,
    NPM_CONFIG_USERCONFIG: join(root, 'empty-npmrc'),
    NPM_CONFIG_REGISTRY: origin + '/npm/',
    npm_config_registry: origin + '/npm/',
  };
  await exec('pnpm', ['run', '--if-present', 'prepublishOnly'], { cwd: folder, env });
  await exec('pnpm', ['pack', '--pack-destination', destination], { cwd: folder, env });
  return () =>
    finishPackageJob(job, f.source, async () => ({
      registry: origin + '/npm/',
      key: issuePipelinePackageToken('owner', job),
    }));
}
await writeFile(join(root, 'empty-npmrc'), '');
process.env.NPM_CONFIG_USERCONFIG = join(root, 'empty-npmrc');
delete process.env.npm_config_userconfig;
test('publish sequentially, fail and retry only the remainder, skip existing, preserve release provenance', async () => {
  const f = await fixture();
  save('pull-request', 'owner', {
    id: 'merged',
    projectId: f.project.id,
    number: 31,
    status: 'merged',
    mergedTargetCommit: f.commit,
    mergedBy: 'owner',
  });
  const run = await start(f);
  await advancePipelinePackages('owner', run.id, registry.copy);
  assert.equal(get('pipeline-run', 'owner', run.id).packages, undefined, 'wait for all jobs');
  pass(run);
  await advancePipelinePackages('owner', run.id, registry.copy);
  assert.equal(
    list('job', 'owner').filter((j) => j.pipelineId === run.id && j.packagePublish).length,
    1,
  );
  const first = claim(run);
  const token = issuePipelinePackageToken('owner', first);
  assert.ok(pipelinePackageIdentity(token));
  assert.equal(JSON.stringify(get('job', 'owner', first.id)).includes(token), false);
  const publish = await packed(f, first);
  await publish();
  const pkg = packageByName(first.packagePublish.name)!;
  assert.equal(pkg.project_id, f.project.id);
  assert.equal(versions(pkg.id)[0].published_via, 'release');
  assert.equal(versions(pkg.id)[0].commit, f.commit);
  assert.equal(JSON.parse(versions(pkg.id)[0].manifest)._deployPipeline.pullNumber, 31);
  save('job', 'owner', { ...first, status: 'succeeded' });
  assert.equal(
    pipelinePackageIdentity(token),
    null,
    'job completion revokes it before the run ends',
  );
  await advancePipelinePackages('owner', run.id, registry.copy);
  const second = claim(run);
  save('job', 'owner', { ...second, status: 'failed', error: 'pack failed' });
  await advancePipelinePackages('owner', run.id, registry.copy);
  assert.equal((pipelineRead('owner', f.project.id, run.id) as any).pipeline.status, 'failed');
  const retry = await start(f);
  pass(retry);
  await advancePipelinePackages('owner', retry.id, registry.copy);
  assert.equal(get('pipeline-run', 'owner', retry.id).packages.items[0].status, 'skipped');
  const rest = claim(retry);
  await (
    await packed(f, rest)
  )();
  save('job', 'owner', { ...rest, status: 'succeeded' });
  await advancePipelinePackages('owner', retry.id, registry.copy);
  assert.equal(get('pipeline-run', 'owner', retry.id).packages.status, 'succeeded');
  const again = await start(f);
  pass(again);
  await advancePipelinePackages('owner', again.id, registry.copy);
  assert.ok(
    get('pipeline-run', 'owner', again.id).packages.items.every((i: any) => i.status === 'skipped'),
  );
});
test('concurrent publications skip an existing version even when the losing upload fails', async () => {
  const f = await fixture(['packages/a']);
  const first = await start(f);
  const second = await start(f);
  for (const run of [first, second]) {
    pass(run);
    await advancePipelinePackages('owner', run.id, registry.copy);
  }
  const winner = claim(first);
  const loser = claim(second);
  await (
    await packed(f, winner)
  )();
  save('job', 'owner', { ...winner, status: 'failed', error: 'Upload response was lost' });
  save('job', 'owner', { ...loser, status: 'failed', error: 'Version is already published' });
  for (const run of [first, second]) await advancePipelinePackages('owner', run.id, registry.copy);
  assert.equal(get('pipeline-run', 'owner', first.id).packages.items[0].status, 'published');
  assert.equal(get('pipeline-run', 'owner', second.id).packages.items[0].status, 'skipped');
  assert.equal(get('pipeline-run', 'owner', second.id).packages.status, 'succeeded');
});
test('failed jobs publish nothing; Cargo skips; public names need an admin claim; foreign owner refused', async () => {
  const f = await fixture(['packages/a']);
  const failed = await start(f);
  pass(failed, 'failed');
  await advancePipelinePackages('owner', failed.id, registry.copy);
  assert.equal(get('pipeline-run', 'owner', failed.id).packages, undefined);
  await rm(join(f.source, 'packages/a/package.json'));
  await writeFile(join(f.source, 'packages/a/Cargo.toml'), '[package]\nname="a"\nversion="1.0.0"');
  await f.git(['add', '.']);
  await f.git(['commit', '-m', 'Cargo']);
  const cargo = await start(f);
  pass(cargo);
  await advancePipelinePackages('owner', cargo.id, registry.copy);
  assert.equal(
    get('pipeline-run', 'owner', cargo.id).packages.items[0].reason,
    "Cargo isn't available yet",
  );
  await writeFile(
    join(f.source, 'packages/a/package.json'),
    '{"name":"public-name","version":"2.0.0"}',
  );
  await f.git(['add', '.']);
  await f.git(['commit', '-m', 'Public']);
  const pub = await start(f);
  pass(pub);
  await advancePipelinePackages('owner', pub.id, registry.copy);
  assert.match(get('pipeline-run', 'owner', pub.id).packages.error, /admin.*--claim/);
  save('project', 'owner', { ...f.project, owner: 'someone' });
  await assert.rejects(start(f), /repository owner's/);
});
test('PR checks pack only changed versions and display only current, free, checked evidence', async () => {
  const f = await fixture(['packages/a']);
  await f.git(['switch', '-c', 'feature']);
  const file = join(f.source, 'packages/a/package.json');
  const pkg = JSON.parse(await readFile(file, 'utf8'));
  pkg.version = '1.1.0';
  await writeFile(file, JSON.stringify(pkg));
  await f.git(['add', '.']);
  await f.git(['commit', '-m', 'Bump']);
  const pull = save('pull-request', 'owner', {
    id: randomUUID(),
    number: 2,
    projectId: f.project.id,
    status: 'open',
    targetBranch: 'main',
    sourceBranch: 'feature',
  });
  const run = await start(f, { pullId: pull.id, trigger: 'pull_request' });
  pass(run);
  await advancePipelinePackages('owner', run.id, registry.copy);
  const job = claim(run);
  assert.throws(() => issuePipelinePackageToken('owner', job), /owner's pipelines/);
  await (
    await packed(f, job)
  )();
  assert.equal(packageByName(pkg.name), undefined);
  save('job', 'owner', { ...job, status: 'succeeded' });
  await advancePipelinePackages('owner', run.id, registry.copy);
  assert.equal((await mergingPackages('owner', f.project, pull))[0].version, '1.1.0');
  const checked = get('pipeline-run', 'owner', run.id);
  save('pipeline-run', 'owner', {
    ...checked,
    specification: { ...checked.specification, paths: ['unrelated/**'] },
  });
  assert.deepEqual(await mergingPackages('owner', f.project, pull), [], 'push would not run');
  save('pipeline-run', 'owner', checked);
  await f.git(['commit', '--allow-empty', '-m', 'New head']);
  assert.deepEqual(await mergingPackages('owner', f.project, pull), []);
  assert.deepEqual(await mergingPackages('owner', f.project, { ...pull, status: 'merged' }), []);
});
test('tokens are scoped, expire after 30 minutes, cannot install, claim, deprecate, or survive cancellation', async () => {
  const f = await fixture(['packages/a']);
  const run = await start(f);
  pass(run);
  await advancePipelinePackages('owner', run.id, registry.copy);
  const job = claim(run);
  const token = issuePipelinePackageToken('owner', job);
  for (const [path, method] of [
    ['-/ping', 'GET'],
    ['other', 'PUT'],
    ['-/package/foo/dist-tags/latest', 'PUT'],
  ]) {
    const response = await fetch(origin + '/npm/' + path, {
      method,
      headers: { authorization: 'Bearer ' + token },
      ...(method === 'PUT' ? { body: '{}' } : {}),
    });
    assert.equal(response.status, 403);
  }
  assert.throws(
    () => issuePipelinePackageToken('owner', { ...job, packagePublish: undefined }),
    /publish job/,
  );
  assert.throws(
    () =>
      jobCommand('owner', 'other', 'package-publish', {
        jobId: job.id,
        generation: job.generation,
        instanceId: job.instanceId,
      }),
    /Stale/,
  );
  const hash = createHash('sha256').update(token).digest('hex');
  const scope = get('pipeline-package-token', '', hash);
  assert.ok(scope.expiresAt - Date.now() <= 30 * 60_000);
  save('pipeline-package-token', '', { ...scope, expiresAt: Date.now() - 1 });
  assert.equal(pipelinePackageIdentity(token), null);
  const next = issuePipelinePackageToken('owner', job);
  save('pipeline-run', 'owner', { ...get('pipeline-run', 'owner', run.id), stopRequested: true });
  assert.equal(pipelinePackageIdentity(next), null);
});
test('older workers fail clearly, and an unavailable capable worker has a deadline', async () => {
  const f = await fixture(['packages/a']);
  const run = await start(f);
  pass(run);
  save('worker', 'owner', {
    id: 'old',
    name: 'Old computer',
    platform: 'linux',
    heartbeat: now(),
    capabilities: ['checkpoint-jobs', 'node'],
  });
  await advancePipelinePackages('owner', run.id, registry.copy);
  assert.match(get('pipeline-run', 'owner', run.id).packages.error, /older workers/);
  save('worker', 'owner', { id: 'old', revokedAt: now() });
  const retry = await start(f);
  pass(retry);
  await advancePipelinePackages('owner', retry.id, registry.copy);
  const item = get('pipeline-run', 'owner', retry.id).packages.items[0];
  const job = get('job', 'owner', item.jobId);
  save('job', 'owner', { ...job, createdAt: '2020-01-01T00:00:00Z' });
  await advancePipelinePackages('owner', retry.id, registry.copy);
  assert.match(get('pipeline-run', 'owner', retry.id).packages.error, /timed out/);
});
test('real job runner receives credentials only after project code exits and never persists them', async () => {
  const f = await fixture(['packages/a']);
  const run = await start(f);
  pass(run);
  await advancePipelinePackages('owner', run.id, registry.copy);
  const entry = get('pipeline-run', 'owner', run.id).packages.items[0];
  const initial = get('job', 'owner', entry.jobId);
  // A local native job runs the real pack without Docker or dependency downloads.
  save('job', 'owner', {
    ...initial,
    requirements: { os: platform() === 'darwin' ? 'macos' : 'linux', capabilities: [] },
    command: `cd packages/a && pnpm run prepublishOnly && pnpm pack --pack-destination .deploy-pipeline-package`,
  });
  db.prepare('INSERT OR REPLACE INTO worker VALUES(?,?,?)').run('local', process.pid, now());
  let token = '',
    calls = 0;
  setPackageHooks({
    installConfig: () => null,
    revokeComputer() {},
    finishJob() {},
    publishConfig: (_owner, job) => {
      calls++;
      token = issuePipelinePackageToken('owner', job);
      return { registry: origin + '/npm/', key: token };
    },
  });
  const runner = new JobRunner(join(root, 'runner'), async (action, body) =>
    jobCommand('owner', 'local', action, { ...body, instanceId: 'runner' }),
  );
  // Do not schedule leftover test jobs into this runner.
  for (const job of list('job', 'owner'))
    if (job.id !== initial.id && ['queued', 'running'].includes(job.status))
      save('job', 'owner', { ...job, status: 'cancelled' });
  try {
    const deadline = Date.now() + 20000;
    while (get('job', 'owner', initial.id).status !== 'succeeded') {
      if (Date.now() > deadline) throw new Error(JSON.stringify(get('job', 'owner', initial.id)));
      await runner.tick();
      await new Promise((done) => setTimeout(done, 40));
    }
    assert.equal(calls, 1);
    assert.ok(token);
    assert.equal(JSON.stringify(get('job', 'owner', initial.id)).includes(token), false);
    assert.equal((await readFile(join(root, 'runner/job.json'), 'utf8')).includes(token), false);
    assert.ok(packageByName(entry.name));
  } finally {
    runner.shutdown();
  }
});

test('a commit that is not on main never publishes, and Run pipeline only deploys if opted in', async () => {
  const f = await fixture(['packages/a']);
  await f.git(['checkout', '-q', '-b', 'unmerged']);
  await f.git(['commit', '-q', '--allow-empty', '-m', 'not merged']);
  const unmerged = await f.git(['rev-parse', 'HEAD']);
  await f.git(['checkout', '-q', 'main']);
  const run = await start(f, { ref: unmerged });
  pass(run);
  await advancePipelinePackages('owner', run.id, registry.copy);
  const after = get('pipeline-run', 'owner', run.id);
  assert.equal(after.packages.items[0].status, 'skipped');
  assert.match(after.packages.items[0].reason, /isn't on main/);
  assert.equal(after.packages.items[0].jobId, undefined);
});
