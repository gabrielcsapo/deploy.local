import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const data = mkdtempSync(join(tmpdir(), 'pipeline-paths-'));
process.env.DEPLOY_DATA_DIR = data;
const { pipelineTrigger, pipelineStart, scanPipelineTriggers } = await import('./pipelines.ts');
const { queuePushTrigger } = await import('./pipeline-triggers.ts');
const { createProject } = await import('./test-repository.ts');
const { git } = await import('./service.ts');
const { save, list, db } = await import('./store.ts');
const owner = 'paths-owner';
after(() => {
  db.close();
  rmSync(data, { recursive: true, force: true });
});

function fixture(paths: string[] | undefined = ['packages/react-flight-router*/**']) {
  const source = join(data, randomUUID());
  mkdirSync(source);
  git(source, ['init', '--initial-branch=main']);
  git(source, ['config', 'user.name', 'Paths']);
  git(source, ['config', 'user.email', 'paths@example.invalid']);
  writeFileSync(
    join(source, 'deploy.yaml'),
    `apiVersion: deploy.local/v1
kind: Application
pipeline:
  on: [manual, push, pull_request]
  branches: [main]
${paths ? `  paths: ${JSON.stringify(paths)}\n` : ''}  jobs:
    check:
      runsOn: {os: linux}
      container: node:26-alpine
      run: 'true'
`,
  );
  function commit(path: string, content: string = randomUUID()) {
    mkdirSync(join(source, path, '..'), { recursive: true });
    writeFileSync(join(source, path), content);
    git(source, ['add', '.']);
    git(source, ['commit', '-m', path]);
    return git(source, ['rev-parse', 'HEAD']);
  }
  const initial = commit('README.md');
  const project = createProject(owner, { name: 'Paths', sourcePath: source });
  function sync(branch = 'main') {
    git(project.repositoryPath, ['fetch', source, `+refs/heads/${branch}:refs/heads/${branch}`]);
  }
  const runs = () => list('pipeline-run', owner).filter((row) => row.projectId === project.id);
  const trigger = (head: string, base?: string, branch = 'main') =>
    pipelineTrigger(owner, project, `refs/heads/${branch}`, head, 'push', undefined, base);
  return { source, project, initial, commit, sync, runs, trigger };
}

test('push paths cover the whole pushed range and queued requests retain the old OID', async () => {
  const f = fixture();
  await scanPipelineTriggers();
  f.commit('packages/react-flight-router/src/new.ts');
  const head = f.commit('README.md');
  f.sync();
  queuePushTrigger(owner, f.project.id, 'refs/heads/main', head, f.initial);
  await scanPipelineTriggers();
  await scanPipelineTriggers();
  assert.equal(f.runs().length, 1);
  assert.equal(f.runs()[0].commit, head);
  const unrelated = f.commit('notes.txt');
  f.sync();
  await f.trigger(unrelated, head);
  assert.equal(f.runs().length, 1);
});

test('branch scans use their previous observation, including multiple commits', async () => {
  const f = fixture();
  await scanPipelineTriggers();
  f.commit('packages/react-flight-router-docs/page.mdx');
  f.commit('README.md');
  f.sync();
  await scanPipelineTriggers();
  assert.equal(f.runs().length, 1);
});

test('renames out of and deletions in a matching directory still trigger', async () => {
  const f = fixture();
  const base = f.commit('packages/react-flight-router/src/old.ts');
  git(f.source, ['mv', 'packages/react-flight-router/src/old.ts', 'moved.ts']);
  git(f.source, ['commit', '-m', 'Move out']);
  const head = git(f.source, ['rev-parse', 'HEAD']);
  f.sync();
  await f.trigger(head, base);
  const beforeDelete = f.commit('packages/react-flight-router/src/deleted.ts');
  git(f.source, ['rm', 'packages/react-flight-router/src/deleted.ts']);
  git(f.source, ['commit', '-m', 'Delete']);
  f.sync();
  await f.trigger(git(f.source, ['rev-parse', 'HEAD']), beforeDelete);
  assert.equal(f.runs().length, 2);
});

test('new refs compare their complete tree; branch filters still apply', async () => {
  const f = fixture();
  await f.trigger(f.initial, '0'.repeat(40));
  assert.equal(f.runs().length, 0);
  const head = f.commit('packages/react-flight-router-shared-ui/src/counter.tsx');
  f.sync();
  await f.trigger(head, '0'.repeat(40), 'feature');
  assert.equal(f.runs().length, 0);
  await f.trigger(head, '0'.repeat(40));
  assert.equal(f.runs().length, 1);
});

test('PR paths compare the merge base, ignoring target-only changes and retaining earlier source changes', async () => {
  const f = fixture();
  git(f.source, ['checkout', '-b', 'feature']);
  const unrelated = f.commit('notes.txt');
  f.sync('feature');
  git(f.source, ['checkout', 'main']);
  f.commit('packages/react-flight-router/src/target-only.ts');
  f.sync();
  const pullId = randomUUID();
  save('pull-request', owner, {
    id: pullId,
    projectId: f.project.id,
    status: 'open',
    sourceBranch: 'feature',
    targetBranch: 'main',
  });
  const trigger = (head: string) =>
    pipelineTrigger(owner, f.project, 'refs/heads/feature', head, 'pull_request', pullId);
  await trigger(unrelated);
  assert.equal(f.runs().length, 0);
  git(f.source, ['checkout', 'feature']);
  f.commit('packages/react-flight-router/src/source.ts');
  const head = f.commit('notes.txt');
  f.sync('feature');
  await trigger(head);
  await trigger(head);
  assert.equal(f.runs().length, 1);
  assert.equal(f.runs()[0].trigger, 'pull_request');
});

test('omitted paths retain existing push behavior and manual runs bypass paths', async () => {
  const f = fixture(undefined);
  // fixture defaults a filter; remove it explicitly in the committed manifest.
  const { readFileSync } = await import('node:fs');
  const manifest = readFileSync(join(f.source, 'deploy.yaml'), 'utf8').replace(
    /^  paths:.*\n/m,
    '',
  );
  const head = f.commit('deploy.yaml', manifest);
  f.sync();
  await f.trigger(head, f.initial);
  assert.equal(f.runs().length, 1);
  const filtered = fixture();
  await pipelineStart(
    owner,
    filtered.project.id,
    { operationId: randomUUID(), trigger: 'manual' },
    'manual',
  );
  assert.equal(filtered.runs().length, 1);
});
