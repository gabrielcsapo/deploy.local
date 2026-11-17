import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const data = mkdtempSync(join(tmpdir(), 'deploy-first-push-'));
process.env.DEPLOY_DATA_DIR = data;
const { openFirstPush } = await import('./first-push.ts');
after(() => rmSync(data, { recursive: true, force: true }));

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const person = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid'];
function run(cwd: string, args: string[]) {
  const result = spawnSync('git', [...person, ...args], { cwd, env, encoding: 'utf8' });
  return { code: result.status, out: result.stdout.trim(), err: result.stderr };
}
function git(cwd: string, args: string[]) {
  const result = run(cwd, args);
  assert.equal(result.code, 0, result.err);
  return result.out;
}
let count = 0;
/** A project repository exactly as deploy.local creates it. */
function project() {
  const repository = join(data, `project-${++count}.git`);
  const seed = join(data, `seed-${count}`);
  mkdirSync(repository);
  mkdirSync(seed);
  git(repository, ['init', '--bare', '--template=', '--initial-branch=main']);
  git(seed, ['init', '--template=', '--initial-branch=main']);
  git(seed, [
    '-c',
    'user.name=deploy.local',
    '-c',
    'user.email=workspace@deploy.local',
    'commit',
    '--allow-empty',
    '-m',
    'Initialize project',
  ]);
  git(seed, ['push', repository, 'HEAD:main']);
  return repository;
}
/** A repository someone already has, sharing no history with the project. */
function existing(branch = 'main') {
  const work = join(data, `work-${++count}`);
  mkdirSync(work);
  git(work, ['init', '--template=', `--initial-branch=${branch}`]);
  writeFileSync(join(work, 'README.md'), 'already written\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-m', 'Existing work']);
  return work;
}
const refs = (repository: string) => git(repository, ['for-each-ref', '--format=%(refname)']);
const head = (repository: string) => git(repository, ['symbolic-ref', 'HEAD']);

test('an existing repository pushes to a new project without pulling or forcing', () => {
  const repository = project();
  const work = existing();
  git(work, ['remote', 'add', 'origin', repository]);
  const refused = run(work, ['push', '-u', 'origin', 'main']);
  assert.notEqual(refused.code, 0, 'outside a first push Git still refuses unrelated history');
  assert.match(refused.err, /fetch first|non-fast-forward/);

  const done = openFirstPush(repository);
  // The project page keeps reading the placeholder through HEAD while the push runs.
  assert.equal(git(repository, ['log', '-1', '--format=%s', 'HEAD']), 'Initialize project');
  git(work, ['push', '-u', 'origin', 'main']);
  done();
  done();
  assert.equal(git(repository, ['log', '--format=%s', 'main']), 'Existing work');
  assert.equal(refs(repository), 'refs/heads/main');
  assert.equal(head(repository), 'refs/heads/main');

  // The next push is an ordinary one.
  const later = openFirstPush(repository);
  assert.equal(refs(repository), 'refs/heads/main');
  later();
  assert.equal(git(repository, ['log', '--format=%s', 'main']), 'Existing work');
});

test('a push that brings nothing to the default branch leaves the placeholder where it was', () => {
  const repository = project();
  const placeholder = git(repository, ['rev-parse', 'main']);
  openFirstPush(repository)();
  assert.equal(git(repository, ['rev-parse', 'main']), placeholder);
  assert.equal(refs(repository), 'refs/heads/main');
  assert.equal(head(repository), 'refs/heads/main');

  const work = existing('develop');
  const done = openFirstPush(repository);
  git(work, ['push', repository, 'develop']);
  done();
  assert.equal(git(repository, ['rev-parse', 'main']), placeholder);
  assert.equal(refs(repository), 'refs/heads/develop\nrefs/heads/main');
  assert.equal(head(repository), 'refs/heads/main');
});

test('two pushes at once settle when the last one ends', () => {
  const repository = project();
  const first = openFirstPush(repository);
  const second = openFirstPush(repository);
  first();
  assert.equal(head(repository), 'refs/deploy/placeholder', 'still open for the second push');
  git(existing(), ['push', repository, 'main']);
  second();
  assert.equal(git(repository, ['log', '--format=%s', 'main']), 'Existing work');
  assert.equal(refs(repository), 'refs/heads/main');
});

test('a project already in use is never touched', () => {
  for (const use of [
    (repository: string) => git(repository, ['update-ref', 'refs/heads/task/1', 'main']),
    (repository: string) => git(repository, ['update-ref', 'refs/deploy/checkpoint/1', 'main']),
    (repository: string) => git(repository, ['tag', 'v1', 'main']),
    (repository: string) => git(existing(), ['push', '--force', repository, 'main']),
  ]) {
    const repository = project();
    use(repository);
    const before = git(repository, ['for-each-ref']);
    const done = openFirstPush(repository);
    assert.equal(git(repository, ['for-each-ref']), before);
    assert.equal(head(repository), 'refs/heads/main');
    done();
    assert.equal(git(repository, ['for-each-ref']), before);
  }
  // A person's own empty first commit is theirs, not the placeholder.
  const repository = project();
  const work = join(data, `work-${++count}`);
  mkdirSync(work);
  git(work, ['init', '--template=', '--initial-branch=main']);
  git(work, ['commit', '--allow-empty', '-m', 'Initialize project']);
  git(work, ['push', '--force', repository, 'main']);
  const before = git(repository, ['for-each-ref']);
  openFirstPush(repository)();
  assert.equal(git(repository, ['for-each-ref']), before);
});

test('a server that stopped mid-push is put right by the next push', () => {
  // Stopped before anything arrived.
  let repository = project();
  const placeholder = git(repository, ['rev-parse', 'main']);
  git(repository, ['update-ref', 'refs/deploy/placeholder', placeholder]);
  git(repository, ['symbolic-ref', 'HEAD', 'refs/deploy/placeholder']);
  git(repository, ['update-ref', '-d', 'refs/heads/main']);
  const done = openFirstPush(repository);
  git(existing(), ['push', repository, 'main']);
  done();
  assert.equal(git(repository, ['log', '--format=%s', 'main']), 'Existing work');
  assert.equal(refs(repository), 'refs/heads/main');

  // Stopped after the push landed but before the placeholder was dropped.
  repository = project();
  git(repository, ['update-ref', 'refs/deploy/placeholder', 'main']);
  git(repository, ['symbolic-ref', 'HEAD', 'refs/deploy/placeholder']);
  git(repository, ['update-ref', '-d', 'refs/heads/main']);
  git(existing(), ['push', repository, 'main']);
  openFirstPush(repository)();
  assert.equal(git(repository, ['log', '--format=%s', 'main']), 'Existing work');
  assert.equal(refs(repository), 'refs/heads/main');
  assert.equal(head(repository), 'refs/heads/main');
});
