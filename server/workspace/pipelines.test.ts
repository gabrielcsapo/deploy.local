import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
const data = mkdtempSync(join(tmpdir(), 'deploy-pipeline-tests-'));
process.env.DEPLOY_DATA_DIR = data;
const { pipelineStart, reconcilePipelines, pipelineRead, pipelineCancel, scanPipelineTriggers } =
  await import('./pipelines.ts');
const { get, save, list, db, now } = await import('./store.ts');
const { createProject } = await import('./test-repository.ts');
const { git } = await import('./service.ts');
const { gitText } = await import('./repository-git.ts');
const { jobCommand } = await import('./coordination.ts');
const { JobRunner } = await import('./job-runner.ts');
const { workspaceApi } = await import('./api.ts');
const { queuePushTrigger, PushCommands } = await import('./pipeline-triggers.ts');
const owner = 'pipeline-owner';
const os = platform() === 'darwin' ? 'macos' : 'linux';
const server = createServer((req, res) => void workspaceApi(req, res, owner));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  rmSync(data, { recursive: true, force: true });
});
function fixture(command = 'printf first', second = 'printf second', on = '[manual, push]') {
  const source = join(data, randomUUID());
  mkdirSync(source);
  git(source, ['init', '--initial-branch=main']);
  git(source, ['config', 'user.name', 'Pipeline']);
  git(source, ['config', 'user.email', 'pipeline@example.invalid']);
  writeFileSync(
    join(source, 'deploy.yaml'),
    `apiVersion: deploy.local/v1\nkind: Application\npipeline:\n  on: ${on}\n  jobs:\n    first:\n      runsOn: {os: ${os}}\n      run: ${JSON.stringify(command)}\n    second:\n      runsOn: {os: ${os}}\n      needs: [first]\n      run: ${JSON.stringify(second)}\n`,
  );
  writeFileSync(join(source, 'source.txt'), 'committed');
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'Pipeline']);
  const project = createProject(owner, { name: 'Pipeline', sourcePath: source });
  return { project, source, commit: git(source, ['rev-parse', 'HEAD']) };
}
async function runUntil(runner: InstanceType<typeof JobRunner>, check: () => boolean) {
  const deadline = Date.now() + 12000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Pipeline timed out');
    reconcilePipelines();
    await runner.tick();
    await new Promise((r) => setTimeout(r, 30));
  }
}
async function start(projectId: string, body: any = {}) {
  return pipelineStart(
    owner,
    projectId,
    { operationId: randomUUID(), ...body },
    JSON.stringify(body),
  );
}
test('real jobs fetch a pinned Git commit, run dependencies and persist checks without a chat task', async () => {
  const f = fixture('cat source.txt', 'test -f deploy.yaml && printf second');
  const input = { operationId: 'pipeline-once' };
  const pipeline = await pipelineStart(owner, f.project.id, input, 'once');
  assert.equal((await pipelineStart(owner, f.project.id, input, 'once')).id, pipeline.id);
  assert.equal(pipeline.taskId, null);
  writeFileSync(join(f.source, 'source.txt'), 'dirty-not-transferred');
  db.prepare('INSERT OR REPLACE INTO worker VALUES(?,?,?)').run('local', process.pid, now());
  const runner = new JobRunner(join(data, 'jobs-pinned'), async (action, body) =>
    jobCommand(owner, 'local', action, { ...body, instanceId: 'pinned' }),
  );
  try {
    await runUntil(runner, () => get('pipeline-run', owner, pipeline.id).status === 'succeeded');
    const detail = pipelineRead(owner, f.project.id, pipeline.id) as any;
    assert.equal(detail.jobs[0].output, 'committed');
    assert.equal(detail.jobs[1].output, 'second');
    assert.ok(detail.jobs.every((job: any) => job.digest === f.commit));
    assert.throws(() => pipelineRead('other', f.project.id, pipeline.id), /Not found/);
  } finally {
    runner.shutdown();
  }
});
test('failed dependencies skip downstream commands; queued cancellation cannot execute', async () => {
  const f = fixture('exit 9', 'echo should-not-run');
  const pipeline = await start(f.project.id);
  const runner = new JobRunner(join(data, 'jobs-failure'), async (action, body) =>
    jobCommand(owner, 'local', action, { ...body, instanceId: 'failure' }),
  );
  try {
    await runUntil(runner, () => get('pipeline-run', owner, pipeline.id).status === 'failed');
    const jobs = (pipelineRead(owner, f.project.id, pipeline.id) as any).jobs;
    assert.equal(jobs[0].exitCode, 9);
    assert.equal(jobs[1].status, 'skipped');
    assert.equal(jobs[1].output, '');
    const stopped = await start(f.project.id);
    pipelineCancel(owner, f.project.id, stopped.id);
    reconcilePipelines();
    assert.equal(get('pipeline-run', owner, stopped.id).status, 'cancelled');
    assert.ok(
      (pipelineRead(owner, f.project.id, stopped.id) as any).jobs.every(
        (job: any) => job.status === 'cancelled',
      ),
    );
  } finally {
    runner.shutdown();
  }
});
test('trigger notifications survive restart and deduplicate against branch scans', async () => {
  const f = fixture();
  await scanPipelineTriggers();
  assert.equal(list('pipeline-run', owner).filter((r) => r.projectId === f.project.id).length, 0);
  writeFileSync(join(f.source, 'source.txt'), 'next');
  git(f.source, ['commit', '-am', 'Next']);
  const next = git(f.source, ['rev-parse', 'HEAD']);
  await gitText(f.source, ['push', `${origin}/api/workspace/git/${f.project.id}`, 'HEAD:main']);
  assert.ok(
    list('pipeline-trigger-request', owner).some(
      (request) => request.projectId === f.project.id && request.commit === next,
    ),
  );
  await scanPipelineTriggers();
  await scanPipelineTriggers();
  const runs = list('pipeline-run', owner).filter((r) => r.projectId === f.project.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].commit, next);
  assert.equal(runs[0].trigger, 'push');
  queuePushTrigger(owner, f.project.id, 'refs/heads/main', next);
  await scanPipelineTriggers();
  assert.equal(list('pipeline-run', owner).filter((r) => r.projectId === f.project.id).length, 1);
  pipelineCancel(owner, f.project.id, runs[0].id);
  reconcilePipelines();
});
test('automatic PR host commands cannot acquire worker credentials; manual owner checks remain available', async () => {
  const f = fixture('true', 'true', '[manual, pull_request]');
  git(f.project.repositoryPath, ['branch', 'feature', f.commit]);
  save('pull-request', owner, {
    id: 'untrusted-pr',
    projectId: f.project.id,
    status: 'open',
    sourceBranch: 'feature',
    targetBranch: 'main',
  });
  await scanPipelineTriggers();
  const failures = list('pipeline-trigger', owner).filter((r) => r.projectId === f.project.id);
  assert.equal(failures.find((r) => r.status === 'failed')?.status, 'failed');
  assert.equal(list('pipeline-run', owner).filter((r) => r.projectId === f.project.id).length, 0);
  const manual = await start(f.project.id, { pullId: 'untrusted-pr' });
  assert.equal(manual.trigger, 'manual');
  pipelineCancel(owner, f.project.id, manual.id);
  reconcilePipelines();
});
test('receive-pack command parser handles chunking and ignores packfile bytes', () => {
  const commands = new PushCommands();
  const body = '0'.repeat(40) + ' ' + 'a'.repeat(40) + ' refs/heads/main\0report-status\n';
  const packet = Buffer.from(
    (body.length + 4).toString(16).padStart(4, '0') + body + '0000PACKgarbage',
  );
  for (const byte of packet) commands.feed(Buffer.from([byte]));
  assert.deepEqual(commands.updates, [{ commit: 'a'.repeat(40), ref: 'refs/heads/main' }]);
});

test('timed-out jobs fail the pipeline and skip dependents instead of waiting forever', async () => {
  const f = fixture();
  const pipeline = await start(f.project.id);
  const jobs = list('job', owner).filter((job) => job.pipelineId === pipeline.id);
  save('job', owner, { ...jobs[0], status: 'timed_out' });
  reconcilePipelines();
  assert.equal(get('job', owner, jobs[1].id).status, 'skipped');
  assert.equal(get('pipeline-run', owner, pipeline.id).status, 'failed');
});
