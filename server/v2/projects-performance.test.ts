import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'projects-performance-'));
process.env.DEPLOY_DATA_DIR = root;
const store = await import('../store.ts');
const workspace = await import('../workspace/store.ts');
const { projectsForOwner } = await import('./projects.ts');
const { repositoryInfo } = await import('../workspace/repositories.ts');
const { gitStringSync } = await import('../git.ts');
after(() => {
  store._resetDb();
  workspace.db.close();
  rmSync(root, { recursive: true, force: true });
});

test('project presentation reuses views, discovers own commits, and writes only missing/changed owners', async (t) => {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => gitStringSync(repo, args);
  const commit = () => {
    git('add', '.');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    );
  };
  const manifest = (name: string) => {
    writeFileSync(
      join(repo, 'deploy.yaml'),
      `apiVersion: deploy.local/v1\nkind: Application\nmetadata:\n  name: ${name}\ncomponents:\n  web:\n    image: example/web\n`,
    );
    commit();
  };
  git('init', '-b', 'main');
  commit();
  workspace.save('project', 'owner', {
    id: 'repo',
    name: 'Repo',
    repositoryPath: repo,
    defaultBranch: 'main',
  });
  store.saveDeployment({ name: 'unrelated', username: 'owner' });
  const database = store.getSqlite()!;
  const transactions = t.mock.method(database, 'transaction');
  const spawn = t.mock.method(childProcess, 'spawn');
  const exec = t.mock.method(childProcess, 'execFile');
  syncBuiltinESMExports();
  t.after(() => {
    spawn.mock.restore();
    exec.mock.restore();
    syncBuiltinESMExports();
  });
  const reads = () =>
    [...spawn.mock.calls, ...exec.mock.calls].map((call) => call.arguments[1] as string[]);
  const resetReads = () => {
    spawn.mock.resetCalls();
    exec.mock.resetCalls();
  };

  await projectsForOwner('owner', true);
  assert.equal(reads().length, 3); // refs + symbolic HEAD + ls-tree, no manifest yet
  assert.equal(transactions.mock.callCount(), 1);
  resetReads();
  transactions.mock.resetCalls();
  await projectsForOwner('owner', true);
  assert.equal(reads().length, 0);
  assert.equal(transactions.mock.callCount(), 0);

  // A manifest arriving after a previous read is discovered, including when the
  // deployment itself arrives later than the manifest/cache entry.
  manifest('web');
  resetReads();
  await projectsForOwner('owner', true);
  assert.equal(reads().length, 4); // refs + symbolic HEAD + ls-tree + show
  assert.equal(transactions.mock.callCount(), 0);
  store.saveDeployment({ name: 'web', username: 'owner' });
  resetReads();
  assert.deepEqual(
    (await projectsForOwner('owner', true)).find((p) => p.id === 'repo')?.apps.map((a) => a.id),
    ['web'],
  );
  assert.equal(reads().length, 0);
  assert.equal(transactions.mock.callCount(), 1);

  // Explicit membership remains authoritative even as the manifest names it.
  store.saveDeployment({ name: 'explicit', username: 'owner' });
  await projectsForOwner('owner', true);
  database
    .prepare('UPDATE project_applications SET project_id=? WHERE application=?')
    .run('chosen', 'explicit');
  manifest('explicit');
  transactions.mock.resetCalls();
  const projects = await projectsForOwner('owner', true);
  assert.deepEqual(
    projects.find((p) => p.id === 'repo')?.apps.map((a) => a.id),
    ['web'],
  );
  assert.deepEqual(
    projects.find((p) => p.id === 'chosen')?.apps.map((a) => a.id),
    ['explicit'],
  );
  assert.equal(transactions.mock.callCount(), 0);

  // Git, rather than filesystem heuristics, handles packed refs and ignores HEAD.
  git('pack-refs', '--all', '--prune');
  git('checkout', '-b', 'other');
  manifest('unrelated');
  resetReads();
  await projectsForOwner('owner', true);
  assert.equal(reads().length, 2); // refs + symbolic HEAD; main manifest stays immutable
  assert.equal(transactions.mock.callCount(), 0);

  database
    .prepare('UPDATE project_applications SET owner=? WHERE application=?')
    .run('old-owner', 'web');
  await projectsForOwner('owner', true);
  assert.equal(transactions.mock.callCount(), 1);
  assert.equal(
    (
      database.prepare('SELECT owner FROM project_applications WHERE application=?').get('web') as {
        owner: string;
      }
    ).owner,
    'owner',
  );

  resetReads();
  await repositoryInfo('owner', 'repo');
  assert.equal(reads().length, 5); // HEAD, tree, refs, ls-tree, show
  await repositoryInfo('owner', 'repo', true);
  resetReads();
  await repositoryInfo('owner', 'repo', true);
  assert.equal(reads().length, 0);
  t.diagnostic(
    'direct repositoryInfo: 5 Git subprocesses; warm presentation reads: 0; warm write transactions: 0',
  );
});
