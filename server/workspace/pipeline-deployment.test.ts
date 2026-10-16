import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
const data = mkdtempSync(join(tmpdir(), 'deploy-pipeline-release-'));
process.env.DEPLOY_DATA_DIR = data;
const { advancePipelineDeployment, pipelineSource } = await import('./pipeline-deployment.ts');
const { get, save, db } = await import('./store.ts');
const { git } = await import('./service.ts');
after(() => {
  db.close();
  rmSync(data, { recursive: true, force: true });
});
function fixture() {
  const source = join(data, randomUUID());
  mkdirSync(source);
  git(source, ['init', '--initial-branch=main']);
  git(source, ['config', 'user.name', 'Test']);
  git(source, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(source, 'hello.txt'), 'tested source');
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'Source']);
  const commit = git(source, ['rev-parse', 'HEAD']);
  const project = save('project', 'owner', { id: randomUUID(), repositoryPath: source });
  const run = save('pipeline-run', 'owner', {
    id: randomUUID(),
    projectId: project.id,
    commit,
    status: 'succeeded',
    deployment: { application: 'app', status: 'ready' },
  });
  return { source, run };
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
