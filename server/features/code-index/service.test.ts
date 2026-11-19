import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import test from 'node:test';

const git = (directory: string, ...args: string[]) =>
  execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

test('first tool use and later default-branch pushes schedule background indexing', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'deploy-code-scheduler-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  process.env.DEPLOY_DATA_DIR = join(folder, 'state');
  const { db, save, list } = await import('../../workspace/store.ts');
  const { queuePushTrigger } = await import('../releases/pipeline-triggers.ts');
  const { callCodeIndex } = await import('./service.ts');
  const checkout = join(folder, 'checkout');
  const repositoryPath = join(folder, 'repo.git');
  mkdirSync(checkout);
  git(checkout, 'init', '-b', 'main');
  git(checkout, 'config', 'user.name', 'Test');
  git(checkout, 'config', 'user.email', 'test@example.test');
  function commit(name: string) {
    writeFileSync(join(checkout, 'index.ts'), `export const ${name} = 1;\n`);
    git(checkout, 'add', 'index.ts');
    git(checkout, 'commit', '-m', 'Update code');
    return git(checkout, 'rev-parse', 'HEAD');
  }
  const first = commit('beforePush');
  git(folder, 'clone', '--bare', checkout, repositoryPath);
  save('project', 'owner', {
    id: 'project',
    name: 'scheduler-fixture',
    defaultBranch: 'main',
    repositoryPath,
  });
  const search = (query: string) =>
    callCodeIndex('owner', 'deploy_code_find', { query }) as Promise<{ matches: number }>;
  const status = () =>
    callCodeIndex('owner', 'deploy_code_project', { project: 'project:project' }) as Promise<{
      status: { commit: string; extractedFiles: number; incremental: boolean; freshness: string };
    }>;
  const until = async (check: () => boolean | Promise<boolean>) => {
    for (let count = 0; count < 120; count++) {
      if (await check()) return;
      await pause(40);
    }
    assert.fail('The code index job did not finish');
  };
  t.after(() => db.close());
  assert.equal((await search('beforePush')).matches, 0);
  await until(async () => (await search('beforePush')).matches === 1);
  assert.equal((await status()).status.commit, first);
  const next = commit('afterPush');
  git(checkout, 'push', repositoryPath, 'main');
  queuePushTrigger('owner', 'project', 'refs/heads/main', next, first);
  // Read Find only until the push's durable job has run. Calling Project would
  // enqueue a stale snapshot itself and hide an integration regression.
  await until(async () => (await search('afterPush')).matches === 1);
  await until(() => list('code-index-request', 'owner').length === 0);
  const current = (await status()).status;
  assert.equal(current.commit, next);
  assert.equal(current.extractedFiles, 1);
  assert.equal(current.incremental, true);
  assert.equal(current.freshness, 'current');
});
