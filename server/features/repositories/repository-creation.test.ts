import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gitText } from '../../workspace/repository-git.ts';
import { continueRepositoryCreation } from './repository-creation-worker.ts';
import { initializeScratchWorkspace } from '../../workspace/scratch.ts';
import { repositoryAddress } from '../../../shared/repository-address.ts';

const directory = mkdtempSync(join(tmpdir(), 'deploy-repository-creation-test-'));
process.env.DEPLOY_DATA_DIR = directory;
const { db, get, list, save, now } = await import('../../workspace/store.ts');
const { createRepository } = await import('./repository-creation.ts');
const { createTask } = await import('../../workspace/test-repository.ts');
const { queueProject } = await import('./repositories.ts');
const { RepositoryRunner } = await import('./repository-runner.ts');
const { workerCommand } = await import('../../workspace/protocol.ts');
const { coordinationApi } = await import('../../workspace/coordination-api.ts');
const { issueAgentToken } = await import('../../workspace/coordination.ts');
const { coordinationTools } = await import('../../workspace/coordination-tools.ts');
const { coordinationInstructions } = await import('../../workspace/agent-launch.ts');
const { publishTask } = await import('../../workspace/publish.ts');
const { inspectWorkspace } = await import('../../workspace/review.ts');
const owner = 'repository-owner';

after(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
function context(workerId = 'local') {
  if (workerId !== 'local')
    workerCommand(owner, '/workers/register', { workerId, platform: 'darwin' });
  const task = createTask(owner, { title: 'Build and ship', workerId });
  const run = save('run', owner, {
    id: randomUUID(),
    taskId: task.id,
    workerId,
    status: 'running',
    generation: randomUUID(),
  });
  return { task, run, scope: { owner, taskId: task.id, runId: run.id } };
}
async function ready(scope: any, args: any) {
  const pending = await createRepository(scope, args);
  assert.equal(pending.pending, true);
  const runner = new RepositoryRunner();
  // Creation follows the exact production queue used by POST /projects.
  await runner.tick();
  return createRepository(scope, args);
}
async function endpoint(token: string, args: any) {
  const req = Object.assign(
    Readable.from([JSON.stringify({ name: 'deploy_create_repository', args })]),
    {
      method: 'POST',
      url: '/api/agent/tools',
      headers: { 'x-deploy-agent-token': token },
    },
  ) as unknown as IncomingMessage;
  let status = 0;
  let result: any;
  const res = {
    writeHead(value: number) {
      status = value;
    },
    end(body: string) {
      result = JSON.parse(body);
    },
  } as ServerResponse;
  await coordinationApi(req, res);
  if (status !== 200) throw Object.assign(new Error(result.error), { status });
  return result;
}

for (const workerId of ['local', 'remote-mac']) {
  test(`${workerId}: no-project task creates, attaches and publishes current files through the authenticated protocol`, async () => {
    const { task, run, scope } = context(workerId);
    let cwd = task.workspacePath;
    if (workerId !== 'local') {
      cwd = join(directory, randomUUID());
      initializeScratchWorkspace(cwd);
    } else await gitText(cwd, ['checkout', '-b', `task/${task.id}`]);
    writeFileSync(join(cwd, 'app.txt'), 'current uncommitted files\n');
    writeFileSync(join(cwd, 'run.sh'), '#!/bin/sh\necho app\n', { mode: 0o755 });
    writeFileSync(join(cwd, '.gitignore'), 'ignored\n');
    writeFileSync(join(cwd, 'ignored'), 'keep local only');
    // An already tracked file must survive even if the current ignore rules match it.
    writeFileSync(join(cwd, 'tracked.txt'), 'tracked contents');
    await gitText(cwd, ['add', 'tracked.txt']);
    writeFileSync(join(cwd, '.gitignore'), 'ignored\ntracked.txt\n');
    const args = {
      operationId: randomUUID(),
      name: `App ${workerId}`,
      description: 'An owned app',
    };
    const token = issueAgentToken(scope);
    const initial = await ready(scope, args);
    assert.equal(get('task', owner, task.id).projectId, initial.project.id);
    let publication: any;
    const result = await continueRepositoryCreation(cwd, args, initial, async (next) => {
      publication = next;
      const [published, retry] = await Promise.all([endpoint(token, next), endpoint(token, next)]);
      assert.deepEqual(retry, published);
      return published;
    });
    const project = get('project', owner, result.project.id);
    assert.equal(project.description, args.description);
    assert.equal(result.branch, 'main');
    assert.match(result.commit, /^[a-f0-9]{40}$/);
    assert.equal(new URL(result.cloneUrl).username, '');
    assert.equal(new URL(result.cloneUrl).password, '');
    assert.equal(await gitText(cwd, ['remote', 'get-url', 'origin']), result.cloneUrl);
    assert.equal(await gitText(cwd, ['branch', '--show-current']), `task/${task.id}`);
    assert.equal(await gitText(cwd, ['rev-parse', 'HEAD']), result.commit);
    assert.equal(await gitText(project.repositoryPath, ['rev-parse', 'main']), result.commit);
    assert.equal(
      await gitText(project.repositoryPath, ['show', 'main:app.txt']),
      'current uncommitted files',
    );
    assert.equal(
      await gitText(project.repositoryPath, ['show', 'main:tracked.txt']),
      'tracked contents',
    );
    assert.match(await gitText(project.repositoryPath, ['ls-tree', 'main', 'run.sh']), /^100755/);
    assert.equal(await gitText(project.repositoryPath, ['ls-tree', 'main', 'ignored']), '');
    assert.equal(readFileSync(join(cwd, 'ignored'), 'utf8'), 'keep local only');
    assert.equal(get('task', owner, task.id).baseRevision, result.commit);
    assert.equal(inspectWorkspace(cwd, result.commit).patch, '');
    assert.deepEqual(await endpoint(token, args), result);
    assert.deepEqual(await endpoint(token, publication), result);
    // Replaying an old tool response uses the fixed worker receipt and preserves follow-up edits.
    writeFileSync(join(cwd, 'app.txt'), 'follow-up edit');
    assert.deepEqual(
      await continueRepositoryCreation(cwd, args, initial, (next) => endpoint(token, next)),
      result,
    );
    assert.equal(readFileSync(join(cwd, 'app.txt'), 'utf8'), 'follow-up edit');
    const messages = list('message', owner).filter(
      (row) => row.repository?.project.id === project.id,
    );
    assert.equal(messages.length, 1);
    // The receipt links to the repository's short address, `deploy.local/<repo>`.
    assert.ok(
      messages[0].content.includes(`(https://deploy.local/${repositoryAddress(project.name)})`),
    );
    if (workerId !== 'local') {
      const ack = workerCommand(owner, `/workers/${workerId}/events`, {
        runId: run.id,
        generation: run.generation,
        events: [],
      });
      assert.equal(ack.repositoryTask.baseRevision, result.commit);
      assert.equal(ack.repositoryTask.projectId, project.id);
    }
    await assert.rejects(
      endpoint(token, { ...args, name: 'different request' }),
      /different command/,
    );
    await assert.rejects(endpoint('invalid-token', args), /credential expired or invalid/);
    await assert.rejects(
      createRepository(scope, { operationId: randomUUID(), name: 'Another app' }),
      new RegExp(project.name),
    );
    if (workerId === 'local') save('run', owner, { ...run, status: 'succeeded' });
    else
      workerCommand(owner, `/workers/${workerId}/complete`, {
        runId: run.id,
        generation: run.generation,
        status: 'succeeded',
        workspacePath: cwd,
        diff: inspectWorkspace(cwd, result.commit),
      });
    const currentTask = get('task', owner, task.id);
    const published = await publishTask(
      owner,
      task.id,
      {
        operationId: randomUUID(),
        revision: currentTask.revision,
      },
      randomUUID(),
    );
    assert.equal(published.pull.status, 'open');
    assert.equal(
      await gitText(project.repositoryPath, ['show', `${published.commit}:app.txt`]),
      'follow-up edit',
    );
    assert.equal(await gitText(project.repositoryPath, ['rev-parse', 'main']), result.commit);
  });
}

test('owner-scoped collisions fail without attaching or overwriting; identical pending retries reserve one project', async () => {
  const { scope, task } = context();
  const existing = queueProject(owner, { name: 'Taken' });
  const runner = new RepositoryRunner();
  await runner.tick();
  const head = await gitText(existing.repositoryPath, ['rev-parse', 'main']);
  await assert.rejects(
    createRepository(scope, { operationId: randomUUID(), name: 'taken' }),
    /Taken.*already exists/,
  );
  assert.equal(get('task', owner, task.id).projectId, null);
  assert.equal(await gitText(existing.repositoryPath, ['rev-parse', 'main']), head);
  const other = context();
  const args = { operationId: randomUUID(), name: 'Pending repository' };
  const [first, retry] = await Promise.all([
    createRepository(other.scope, args),
    createRepository(other.scope, args),
  ]);
  assert.deepEqual(first, { pending: true });
  assert.deepEqual(retry, first);
  assert.equal(list('project', owner).filter((row) => row.name === args.name).length, 1);
  assert.equal(queueProject('another-owner', { name: 'Taken' }).name, 'Taken');
  // Drain pending repository operations so later tests prepare their own reservation.
  await runner.tick();
  await runner.tick();
});

test('publication refuses a moved main, preserves files and can recover a lost final response', async () => {
  const { task, scope } = context();
  const args = { operationId: randomUUID(), name: 'Recovery app' };
  writeFileSync(join(task.workspacePath, 'source'), 'first version');
  const initial = await ready(scope, args);
  let result: any;
  await assert.rejects(
    continueRepositoryCreation(task.workspacePath, args, initial, async (next) => {
      result = await createRepository(scope, next);
      throw new Error('Lost final response');
    }),
    /Lost final response/,
  );
  assert.deepEqual(
    await continueRepositoryCreation(
      task.workspacePath,
      args,
      await createRepository(scope, args),
      async () => {
        throw new Error('must not republish');
      },
    ),
    result,
  );

  const moved = context();
  const movedArgs = { operationId: randomUUID(), name: 'Moved app' };
  const prepared = await ready(moved.scope, movedArgs);
  const project = get('project', owner, prepared.project.id);
  const tree = await gitText(project.repositoryPath, ['rev-parse', 'main^{tree}']);
  const externalCommit = await gitText(
    project.repositoryPath,
    ['commit-tree', tree, '-p', prepared.seed],
    { identity: 'another-user', input: 'Concurrent commit' },
  );
  await gitText(project.repositoryPath, ['update-ref', 'refs/heads/main', externalCommit]);
  await assert.rejects(
    continueRepositoryCreation(moved.task.workspacePath, movedArgs, prepared, (next) =>
      createRepository(moved.scope, next),
    ),
    /refusing to overwrite/,
  );
  assert.equal(await gitText(project.repositoryPath, ['rev-parse', 'main']), externalCommit);
});

test('worker refuses excluded credentials and setup failure never claims an initial commit', async () => {
  const { scope, task } = context();
  const args = { operationId: randomUUID(), name: 'Excluded files' };
  const initial = await ready(scope, args);
  writeFileSync(join(task.workspacePath, '.env'), 'SECRET=do-not-publish');
  await assert.rejects(
    continueRepositoryCreation(task.workspacePath, args, initial, async () => {
      throw new Error('must not send');
    }),
    /excluded files.*\.env/,
  );
  assert.equal(list('message', owner).filter((row) => row.taskId === task.id).length, 0);
  const project = get('project', owner, initial.project.id);
  save('project', owner, { ...project, repositoryStatus: 'failed', updatedAt: now() });
  await assert.rejects(createRepository(scope, args), /setup failed/);
});

test('instructions and tool descriptions require the complete repeatable shipping loop', () => {
  const create = coordinationTools.find((tool) => tool.name === 'deploy_create_repository')!;
  assert.deepEqual(create.inputSchema.required, ['operationId', 'name']);
  assert.equal(create.inputSchema.additionalProperties, false);
  for (const guidance of [
    'deploy_create_repository',
    'deploy.yaml',
    'deploy_checkpoint',
    'deploy_run_job',
    'macos',
    '[xcode]',
    'linux',
    'deploy_application',
    'https://<name>.local',
    'localhost',
    'Swift test target',
    'reads it back',
    'system CA',
    'deploy_commit',
    'never run git commit or git push in the shell',
    'deploy_project',
    'follow-up',
    'repository',
    'jobs',
  ]) {
    assert.ok(coordinationInstructions.includes(guidance), `Missing ${guidance}`);
    assert.ok(
      coordinationTools
        .find((tool) => tool.name === 'deploy_application')!
        .description.includes(guidance),
      `Tool missing ${guidance}`,
    );
  }
});

test('worker waits for queued repository setup with the same operation and times out without fabricating success', async () => {
  const { scope, task } = context();
  const args = { operationId: randomUUID(), name: 'Queued app' };
  const initial = await createRepository(scope, args);
  let waits = 0;
  const runner = new RepositoryRunner();
  const result = await continueRepositoryCreation(
    task.workspacePath,
    args,
    initial,
    (next) => createRepository(scope, next),
    {
      wait: async () => {
        waits++;
        await runner.tick();
      },
    },
  );
  assert.equal(waits, 1);
  assert.equal(result.commit, get('task', owner, task.id).baseRevision);
  let clock = 0;
  await assert.rejects(
    continueRepositoryCreation(
      task.workspacePath,
      args,
      { pending: true },
      async () => ({ pending: true }),
      {
        now: () => clock,
        wait: async () => {
          clock = 600001;
        },
      },
    ),
    /still pending.*identical operationId/,
  );
});
