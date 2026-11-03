import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { SelfUpdateRun } from '../../shared/v2/contracts.ts';

process.env.DEPLOY_DATA_DIR = mkdtempSync(join(tmpdir(), 'self-update-data-'));
const { changesSince, estimate, findSourceRepository, settleRun } =
  await import('./self-update.ts');
// @ts-expect-error The runner is plain JavaScript so it can run without a build.
const { readPrepare, prepareDetail } = await import('../../scripts/self-update.mjs');

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
function repository(seed = '1') {
  const root = mkdtempSync(join(tmpdir(), 'self-update-'));
  const work = join(root, 'work');
  mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  writeFileSync(join(work, 'a.txt'), seed);
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'First');
  const running = git(work, 'rev-parse', 'HEAD');
  for (const subject of ['Second', 'Third']) {
    writeFileSync(join(work, 'a.txt'), subject);
    git(work, 'commit', '-qam', subject);
  }
  const bare = join(root, 'source.git');
  git(root, 'clone', '-q', '--bare', work, bare);
  return { root, work, bare, running, main: git(work, 'rev-parse', 'HEAD') };
}

test('finds the repository whose main contains the running version and lists what is newer', () => {
  const repo = repository();
  const other = repository('other');
  const found = findSourceRepository(
    [
      { name: 'Tally', path: other.bare },
      { name: 'deploy.local', path: repo.bare },
    ],
    repo.running,
  );
  assert.equal(found?.path, repo.bare);
  const { main, ahead, changes } = changesSince(repo.bare, repo.running);
  assert.equal(main, repo.main);
  assert.equal(ahead, 2);
  assert.deepEqual(
    changes.map((c) => c.subject),
    ['Third', 'Second'],
  );
  assert.equal(
    findSourceRepository([{ name: 'Tally', path: other.bare }], repo.running),
    undefined,
  );
});

const run = (over: Partial<SelfUpdateRun> = {}): SelfUpdateRun => ({
  id: 'abcdef12-0000',
  from: 'aaa',
  to: 'bbb',
  state: 'running',
  startedAt: new Date(0).toISOString(),
  startedBy: 'gabriel',
  steps: [
    { id: 'prepare', state: 'done' },
    { id: 'backup', state: 'done' },
    { id: 'restart', state: 'running' },
    { id: 'check', state: 'waiting' },
  ],
  ...over,
});
test('a run whose updater is gone is done when its version serves, failed otherwise', () => {
  assert.equal(settleRun(run(), 'aaa', () => true)?.state, 'running');
  assert.equal(settleRun(run(), 'bbb', () => false)?.state, 'done');
  const failed = settleRun(run(), 'aaa', () => false)!;
  assert.equal(failed.state, 'failed');
  assert.deepEqual(
    failed.steps.map((s) => s.state),
    ['done', 'done', 'failed', 'skipped'],
  );
  // Just started: systemd may not list the unit yet.
  assert.equal(
    settleRun(run({ startedAt: new Date().toISOString() }), 'aaa', () => false)?.state,
    'running',
  );
});

test('the estimate is the last successful update, or six minutes', () => {
  assert.equal(estimate([]), 360_000);
  assert.equal(
    estimate([
      run({ state: 'done', startedAt: '2026-11-02T00:00:00Z', finishedAt: '2026-11-02T00:04:00Z' }),
      run({
        state: 'failed',
        startedAt: '2026-11-02T01:00:00Z',
        finishedAt: '2026-11-02T01:01:00Z',
      }),
    ]),
    240_000,
  );
});

test('prepare output says which step failed and how many tests', () => {
  const out = [
    'pnpm install --frozen-lockfile',
    'pnpm typecheck',
    'pnpm build',
    'pnpm test',
    'ℹ pass 200',
    'ℹ fail 0',
    'ℹ pass 79',
    'ℹ fail 2',
    '  test at server/v2/design.test.ts:40:1',
  ].join('\n');
  assert.equal(
    prepareDetail(readPrepare(out), false),
    '2 of 281 tests failed in server/v2/design.test.ts',
  );
  assert.equal(
    prepareDetail(readPrepare('pnpm install --frozen-lockfile\npnpm typecheck\nerror'), false),
    'pnpm typecheck failed',
  );
  assert.equal(
    prepareDetail(readPrepare('pnpm test\nℹ pass 281\nℹ fail 0'), true),
    'install, typecheck, build, 281 tests passed',
  );
});

function rehearsal(activate: string) {
  const repo = repository();
  const releases = join(repo.root, 'releases');
  mkdirSync(releases);
  const serving = join(releases, 'serving');
  git(repo.root, 'clone', '-q', repo.work, serving);
  git(serving, 'checkout', '-q', '--detach', repo.running);
  const current = join(repo.root, 'current');
  symlinkSync(serving, current);
  const data = join(repo.root, 'data');
  mkdirSync(join(data, 'workspace'), { recursive: true });
  mkdirSync(join(data, 'backups'));
  for (const path of [join(data, 'deploy.db'), join(data, 'workspace', 'workspace.db')]) {
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE t(x); INSERT INTO t VALUES (1)');
    db.close();
  }
  const bin = join(repo.root, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'deploy-update'),
    `#!/bin/sh\nif [ "$1" = prepare ]; then printf 'pnpm test\\nℹ pass 12\\nℹ fail 0\\n'; exit 0; fi\n${activate}\n`,
  );
  chmodSync(join(bin, 'deploy-update'), 0o755);
  const state = join(repo.root, 'current.json');
  writeFileSync(
    state,
    JSON.stringify({
      ...run({ from: repo.running, to: repo.main, startedAt: new Date().toISOString() }),
      steps: ['prepare', 'backup', 'restart', 'check'].map((id) => ({ id, state: 'waiting' })),
      plan: {
        repository: repo.bare,
        computer: 'SER',
        release: join(releases, 'next'),
        current,
        data,
        log: join(repo.root, 'run.log'),
        history: join(repo.root, 'history.json'),
      },
    }),
  );
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dirname, '../../scripts/self-update.mjs'), state],
    { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
  );
  assert.equal(result.stderr, '');
  return {
    repo,
    data,
    releases,
    result: JSON.parse(readFileSync(state, 'utf8')) as SelfUpdateRun,
    history: JSON.parse(readFileSync(join(repo.root, 'history.json'), 'utf8')),
  };
}

test('the runner checks out main in a new release, backs up both databases and activates it', () => {
  const { repo, data, releases, result, history } = rehearsal('echo Serving; exit 0');
  assert.equal(result.state, 'done');
  assert.deepEqual(
    result.steps.map((s) => s.state),
    ['done', 'done', 'done', 'done'],
  );
  assert.match(result.steps[0].detail!, /^install, typecheck, build, 12 tests passed · \d+ s$/);
  assert.equal(git(join(releases, 'next'), 'rev-parse', 'HEAD'), repo.main);
  const short = repo.main.slice(0, 7);
  for (const name of ['deploy', 'workspace']) {
    const copy = new DatabaseSync(join(data, 'backups', `self-update-${short}-${name}.db`));
    assert.equal(copy.prepare('SELECT x FROM t').get()?.x, 1);
    copy.close();
  }
  assert.equal(history.at(-1).state, 'done');
  assert.equal(history.at(-1).plan, undefined);
});

test('a failed activation that went back says so', () => {
  const { repo, result } = rehearsal(
    'echo "Update failed; restored /releases/serving." >&2; exit 1',
  );
  assert.equal(result.state, 'failed');
  assert.equal(result.rolledBack, true);
  assert.deepEqual(
    result.steps.map((s) => s.state),
    ['done', 'done', 'failed', 'skipped'],
  );
  assert.equal(
    result.error,
    `${repo.main.slice(0, 7)} did not come back healthy, so SER went back to ${repo.running.slice(0, 7)}.`,
  );
});
