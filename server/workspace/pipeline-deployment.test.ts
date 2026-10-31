import test, { after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
const data = mkdtempSync(join(tmpdir(), 'deploy-pipeline-release-'));
process.env.DEPLOY_DATA_DIR = data;
const { advancePipelineDeployment, pipelineSource, pipelineBundle } =
  await import('./pipeline-deployment.ts');
const { get, save, db } = await import('./store.ts');
const { git } = await import('./service.ts');
const { createProject } = await import('./test-repository.ts');
const store = await import('../store.ts');
const { registerApplicationIdentity } = await import('../multisite.ts');
const { consumeAgentUpload, assertAgentApplication, recordAgentUpload, recordApplicationOrigin } =
  await import('../agent-upload.ts');
afterEach(() => mock.restoreAll());
after(() => {
  db.close();
  store.getSqlite()?.close();
  rmSync(data, { recursive: true, force: true });
});
function fixture() {
  const source = join(data, randomUUID());
  mkdirSync(source);
  git(source, ['init', '--initial-branch=main']);
  git(source, ['config', 'user.name', 'Test']);
  git(source, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(
    join(source, 'deploy.yaml'),
    'apiVersion: deploy.local/v1\nkind: Application\nmetadata: { name: app }\ncomponents:\n  web:\n    build: { context: . }\n',
  );
  writeFileSync(join(source, 'hello.txt'), 'tested source');
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'Source']);
  const commit = git(source, ['rev-parse', 'HEAD']);
  const project = createProject('owner', { name: 'Pipeline', sourcePath: source });
  const run = save('pipeline-run', 'owner', {
    id: randomUUID(),
    projectId: project.id,
    commit,
    status: 'succeeded',
    deployment: { application: 'app', status: 'ready' },
  });
  return { source, project, run };
}
test('release handoff pins source, survives lost reservation/upload responses and reports the existing release', async () => {
  const { source, run } = fixture();
  let receipt: any,
    reserved = 0,
    uploaded = 0,
    closed = 0;
  let lostReservation = true,
    lostUpload = true;
  const access = async (owner: string, application: string) => {
    assert.equal(owner, 'owner');
    assert.equal(application, 'app');
    return {
      close: () => {
        closed++;
      },
      request: async (path: string, options?: RequestInit) => {
        if (path.endsWith('/head')) return { releaseId: 'baseline:one' };
        if (path.endsWith('/upload')) {
          assert.equal(receipt.status, 'accepted');
          const form = options!.body as FormData;
          const bytes = Buffer.from(await (form.get('file') as Blob).arrayBuffer());
          assert.ok(gunzipSync(bytes).includes(Buffer.from('tested source')));
          assert.ok(!gunzipSync(bytes).includes(Buffer.from('uncommitted')));
          uploaded++;
          receipt.status = 'building';
          if (lostUpload) {
            lostUpload = false;
            throw new Error('Connection lost after upload');
          }
          return {};
        }
        if (options?.method === 'POST') {
          const intent = JSON.parse(String(options.body));
          if (!receipt) {
            reserved++;
            receipt = {
              ...intent,
              predecessorReleaseId: intent.expectedRelease,
              releaseId: randomUUID(),
              status: 'accepted',
            };
          }
          assert.equal(intent.expectedRelease, 'baseline:one');
          if (lostReservation) {
            lostReservation = false;
            throw new Error('Connection lost after reservation');
          }
        }
        return { ...receipt };
      },
    };
  };
  writeFileSync(join(source, 'hello.txt'), 'uncommitted');
  await advancePipelineDeployment('owner', run.id, access);
  assert.equal(get('pipeline-run', 'owner', run.id).deployment.status, 'publishing');
  await advancePipelineDeployment('owner', run.id, access);
  await advancePipelineDeployment('owner', run.id, access);
  assert.equal(uploaded, 1);
  assert.equal(reserved, 1);
  receipt.status = 'healthy';
  receipt.containerId = 'container';
  receipt.imageDigest = 'sha256:' + 'a'.repeat(64);
  await advancePipelineDeployment('owner', run.id, access);
  assert.equal(get('pipeline-run', 'owner', run.id).deployment.status, 'succeeded');
  assert.equal(closed, 4);
});
test('failed checks never publish, mismatched receipt stays unknown, source bundles are deterministic', async () => {
  const { source, run } = fixture();
  const first = await pipelineSource(source, run.commit),
    second = await pipelineSource(source, run.commit);
  assert.equal(first.sourceDigest, second.sourceDigest);
  save('pipeline-run', 'owner', { ...run, status: 'failed' });
  let calls = 0;
  const access = async () => ({
    close() {},
    request: async () => {
      calls++;
      return { releaseId: 'wrong' };
    },
  });
  await advancePipelineDeployment('owner', run.id, access);
  assert.equal(calls, 0);
  save('pipeline-run', 'owner', run);
  await advancePipelineDeployment('owner', run.id, access);
  assert.equal(get('pipeline-run', 'owner', run.id).deployment.status, 'unknown');
  assert.match(get('pipeline-run', 'owner', run.id).deployment.error, /receipt/);
});

const manifest = (application: string) => `apiVersion: deploy.local/v1
kind: Application
metadata: { name: ${application} }
components:
  web:
    build: { context: ., ignore: [excluded] }
    interfaces:
      http: { protocol: http, port: 3000 }
routes:
  public: { to: web.http }
`;
function fullFixture(extra = '', path = '.') {
  const fixtureData = fixture();
  const application = `app-${randomUUID().slice(0, 8)}`;
  for (const [file, content] of Object.entries({
    'deploy.yaml': manifest(application) + extra,
    Dockerfile: 'FROM scratch',
    'hello.txt': 'pinned source',
    'excluded/private.txt': 'excluded source',
  })) {
    const target = join(fixtureData.source, path, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  git(fixtureData.source, ['add', '.']);
  git(fixtureData.source, ['commit', '-m', 'Application']);
  const commit = git(fixtureData.source, ['rev-parse', 'HEAD']);
  git(fixtureData.source, ['push', fixtureData.project.repositoryPath, 'HEAD:main']);
  const run = save('pipeline-run', 'owner', {
    ...fixtureData.run,
    commit,
    deployment: { application, path, status: 'ready' },
  });
  store.ensureCoordinatorNode();
  store.setDefaultNode('coordinator');
  return { ...fixtureData, run, application };
}
function stubUpload(
  options: { gate?: string; failed?: boolean; lost?: boolean; releasing?: boolean } = {},
) {
  const uploads: { scope: any; bytes: Buffer; buildLogId: number }[] = [];
  mock.method(globalThis, 'fetch', async (input: any, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.url, 'http://127.0.0.1:7843/api/upload');
    assert.equal(init?.redirect, 'error');
    const scope = consumeAgentUpload({
      method: 'POST',
      url: '/api/upload',
      headers: Object.fromEntries(request.headers),
      socket: { remoteAddress: '127.0.0.1' },
    } as any)!;
    assert.equal(scope.owner, 'owner');
    assertAgentApplication(scope); // same check the upload handler performs under its lease
    const form = await request.formData();
    assert.deepEqual([...form.keys()].sort(), ['detached', 'file', 'name']);
    const bytes = gunzipSync(Buffer.from(await (form.get('file') as Blob).arrayBuffer()));
    if (options.gate) return Response.json({ error: options.gate }, { status: 409 });
    store.registerDeploymentStart(scope.application, scope.owner, 'application-graph');
    registerApplicationIdentity(scope.application);
    store.updateDeploymentArtifactDigests(scope.application, {
      sourceArtifactDigest: 'sha256:' + randomUUID().replaceAll('-', '').repeat(2),
    });
    const buildLogId = store.createBuildLog(scope.application);
    store.updateCurrentBuildLogId(scope.application, buildLogId);
    recordAgentUpload(scope, buildLogId);
    // A release keeps its build open while it verifies, activates and watches.
    if (options.releasing) {
      store.updateDeploymentStatus(scope.application, 'building');
      uploads.push({ scope, bytes, buildLogId });
      return Response.json({ buildLogId }, { status: 202 });
    }
    store.updateDeploymentStatus(
      scope.application,
      options.failed ? 'configuration-required' : 'running',
    );
    store.completeBuildLog(buildLogId, { success: !options.failed, duration: 1 });
    uploads.push({ scope, bytes, buildLogId });
    if (options.lost) throw new TypeError('Connection lost after admission');
    return Response.json({ buildLogId }, { status: 202 });
  });
  return uploads;
}
test('first upload creates an app from a pinned hosted commit and the same repository can redeploy', async () => {
  const { source, project, run, application } = fullFixture('', 'apps/web');
  writeFileSync(join(source, 'apps/web/hello.txt'), 'newer untested commit');
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'Advance main after pipeline was pinned']);
  git(source, ['push', project.repositoryPath, 'HEAD:main']);
  writeFileSync(join(source, 'apps/web/hello.txt'), 'uncommitted worker output');
  const uploads = stubUpload();
  await advancePipelineDeployment('owner', run.id);
  assert.equal(uploads.length, 1);
  assert.ok(uploads[0].bytes.includes(Buffer.from('pinned source')));
  assert.ok(!uploads[0].bytes.includes(Buffer.from('uncommitted worker output')));
  assert.ok(!uploads[0].bytes.includes(Buffer.from('newer untested commit')));
  assert.ok(!uploads[0].bytes.includes(Buffer.from('excluded source')));
  assert.equal(get('pipeline-run', 'owner', run.id).deployment.status, 'publishing');
  await advancePipelineDeployment('owner', run.id);
  const completed = get('pipeline-run', 'owner', run.id).deployment;
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.url, `https://${application}.local`);
  assert.equal(completed.buildLogId, uploads[0].buildLogId);
  const origin = get('application-origin', 'owner', application);
  assert.equal(origin.projectId, project.id);
  assert.equal(origin.owner, 'owner');
  assert.equal(origin.status, 'running');
  const next = save('pipeline-run', 'owner', { ...run, id: randomUUID() });
  await advancePipelineDeployment('owner', next.id);
  await advancePipelineDeployment('owner', next.id);
  assert.equal(uploads.length, 2);
  assert.equal(get('pipeline-run', 'owner', next.id).deployment.status, 'succeeded');
});
test('waits through a full release, and only gives up long after one should finish', async () => {
  const { run } = fullFixture();
  stubUpload({ releasing: true });
  await advancePipelineDeployment('owner', run.id);
  const startedMinutesAgo = async (minutes: number) => {
    const current = get('pipeline-run', 'owner', run.id);
    save('pipeline-run', 'owner', {
      ...current,
      deployment: {
        ...current.deployment,
        startedAt: new Date(Date.now() - minutes * 60_000).toISOString(),
      },
    });
    await advancePipelineDeployment('owner', run.id);
    return get('pipeline-run', 'owner', run.id).deployment;
  };
  // Verify plus a 10-minute Watch runs well past ten minutes.
  const releasing = await startedMinutesAgo(20);
  assert.equal(releasing.status, 'publishing', releasing.error);
  const stalled = await startedMinutesAgo(80);
  assert.equal(stalled.status, 'failed');
  assert.match(stalled.error, /Timed out waiting for build\/start/);
});
test('volume resources use the full upload path', async () => {
  const { run, source, project } = fullFixture(`resources:
  data:
    type: volume
    backup: { policy: required, retentionCopies: 7 }
`);
  const file = join(source, 'deploy.yaml');
  writeFileSync(
    file,
    manifest(run.deployment.application).replace(
      '    interfaces:',
      '    mounts: { /data: { resource: data } }\n    interfaces:',
    ) +
      `resources:
  data:
    type: volume
    backup: { policy: required, retentionCopies: 7 }
`,
  );
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'Mount durable volume']);
  git(source, ['push', project.repositoryPath, 'HEAD:main']);
  save('pipeline-run', 'owner', { ...run, commit: git(source, ['rev-parse', 'HEAD']) });
  const uploads = stubUpload();
  await advancePipelineDeployment('owner', run.id);
  assert.equal(
    get('pipeline-run', 'owner', run.id).deployment.method,
    'upload',
    get('pipeline-run', 'owner', run.id).deployment.error,
  );
  assert.equal(uploads.length, 1);
  assert.ok(uploads[0].bytes.includes(Buffer.from('type: volume')));
});
test('another repository, another owner and stale provenance cannot overwrite an existing app', async () => {
  const { run, application, project } = fullFixture();
  const uploads = stubUpload();
  await advancePipelineDeployment('owner', run.id);
  await advancePipelineDeployment('owner', run.id);
  const foreign = fullFixture();
  const attempt = save('pipeline-run', 'owner', {
    ...run,
    id: randomUUID(),
    projectId: foreign.project.id,
  });
  await advancePipelineDeployment('owner', attempt.id);
  assert.match(
    get('pipeline-run', 'owner', attempt.id).deployment.error,
    /Deploy it once yourself.*rename/,
  );
  assert.equal(uploads.length, 1);
  assert.throws(
    () =>
      assertAgentApplication({
        owner: 'other',
        application,
        projectId: project.id,
        pipelineId: run.id,
      }),
    /Not found/,
  );
  store.updateCurrentBuildLogId(application, store.createBuildLog(application));
  const stale = save('pipeline-run', 'owner', { ...run, id: randomUUID() });
  await advancePipelineDeployment('owner', stale.id);
  assert.equal(get('pipeline-run', 'owner', stale.id).deployment.status, 'failed');
  assert.equal(uploads.length, 1);
});
test('an owner manual deployment associated with this repository authorizes its pipeline', async () => {
  const { run, project, application } = fullFixture();
  store.registerDeploymentStart(application, 'owner', 'application-graph');
  registerApplicationIdentity(application);
  const build = store.createBuildLog(application);
  store.updateCurrentBuildLogId(application, build);
  recordApplicationOrigin({ owner: 'owner', projectId: project.id, application }, build);
  const uploads = stubUpload();
  await advancePipelineDeployment('owner', run.id);
  assert.equal(uploads.length, 1);
});
test('gates fail with their reason and manual recovery; admitted failures retain the exact build', async () => {
  for (const gate of [
    'Destructive repository application changes require --confirm-destructive',
    'Missing required secret DATABASE_PASSWORD',
  ]) {
    const { run } = fullFixture();
    stubUpload({ gate });
    await advancePipelineDeployment('owner', run.id);
    const result = get('pipeline-run', 'owner', run.id).deployment;
    assert.equal(result.status, 'failed');
    assert.ok(result.error.includes(gate));
    assert.match(result.error, /Deploy manually/);
    assert.equal(result.buildLogId, undefined);
    mock.restoreAll();
  }
  const { run } = fullFixture();
  const uploads = stubUpload({ failed: true });
  await advancePipelineDeployment('owner', run.id);
  await advancePipelineDeployment('owner', run.id);
  const result = get('pipeline-run', 'owner', run.id).deployment;
  assert.equal(result.status, 'failed');
  assert.match(result.error, /configuration-required.*Deploy manually/);
  assert.equal(result.buildLogId, uploads[0].buildLogId);
});
test('lost upload response resumes the admitted build and interrupted uploads are never repeated', async () => {
  const { run } = fullFixture();
  const uploads = stubUpload({ lost: true });
  await advancePipelineDeployment('owner', run.id);
  await advancePipelineDeployment('owner', run.id);
  assert.equal(get('pipeline-run', 'owner', run.id).deployment.status, 'succeeded');
  assert.equal(uploads.length, 1);
  const interrupted = save('pipeline-run', 'owner', {
    ...run,
    id: randomUUID(),
    deployment: {
      ...run.deployment,
      method: 'upload',
      status: 'publishing',
      startedAt: new Date().toISOString(),
    },
  });
  await advancePipelineDeployment('owner', interrupted.id);
  assert.match(get('pipeline-run', 'owner', interrupted.id).deployment.error, /interrupted/);
  assert.equal(uploads.length, 1);
});
test('source validates metadata, app root and commit before upload; only owner pipelines may deploy', async () => {
  const { run, project, application } = fullFixture();
  await assert.rejects(
    pipelineBundle(project.repositoryPath, run.commit, '../escape', application),
    /subdirectory/,
  );
  await assert.rejects(
    pipelineBundle(project.repositoryPath, run.commit, '.', 'different'),
    /must match/,
  );
  await assert.rejects(
    pipelineBundle(project.repositoryPath, 'HEAD', '.', application),
    /Full source commit/,
  );
  const uploads = stubUpload();
  save('project', 'owner', { ...project, owner: 'someone-else' });
  await advancePipelineDeployment('owner', run.id);
  assert.match(get('pipeline-run', 'owner', run.id).deployment.error, /repository owner's/);
  assert.equal(uploads.length, 0);
});

test('the pinned source expands verified hosted LFS content before applying bundle rules', async () => {
  const { source, project, run, application } = fullFixture();
  const bytes = Buffer.from('verified LFS application source');
  const oid = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(
    join(source, 'asset.txt'),
    `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${bytes.length}\n`,
  );
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'Pinned LFS object']);
  git(source, ['push', project.repositoryPath, 'HEAD:main']);
  const commit = git(source, ['rev-parse', 'HEAD']);
  const object = join(project.repositoryPath, 'lfs/objects', oid.slice(0, 2), oid.slice(2, 4), oid);
  mkdirSync(dirname(object), { recursive: true });
  writeFileSync(object, bytes);
  const bundle = await pipelineBundle(project.repositoryPath, commit, '.', application);
  assert.ok(gunzipSync(bundle.body).includes(bytes));
  assert.ok(!gunzipSync(bundle.body).includes(Buffer.from('oid sha256:')));
  writeFileSync(object, Buffer.alloc(bytes.length));
  await assert.rejects(
    pipelineBundle(project.repositoryPath, commit, run.deployment.path, application),
    /verification/,
  );
});
