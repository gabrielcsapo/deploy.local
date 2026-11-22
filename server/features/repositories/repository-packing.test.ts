import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const data = mkdtempSync(join(tmpdir(), 'deploy-packing-'));
process.env.DEPLOY_DATA_DIR = data;
const { needsPacking, packAll, packRepository, packingSettings, packingSettled, schedulePacking } =
  await import('./repository-packing.ts');
const logs: string[] = [];
packingSettings.log = (message) => logs.push(message);
after(async () => {
  await packingSettled();
  rmSync(data, { recursive: true, force: true });
});

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const person = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid'];
function git(cwd: string, args: string[]) {
  const result = spawnSync('git', [...person, ...args], { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function count(repository: string) {
  return Object.fromEntries(
    git(repository, ['count-objects', '-v'])
      .split('\n')
      .map((line) => line.split(': '))
      .map(([key, value]) => [key, Number(value)]),
  );
}

let made = 0;
/** A hosted repository after several pushes: some kept as packs, some unpacked loose. */
function pushed(pushes: number) {
  const id = `project-${++made}`;
  const repository = join(data, 'repositories', `${id}.git`);
  const work = join(data, `work-${made}`);
  mkdirSync(repository, { recursive: true });
  mkdirSync(work);
  git(repository, ['init', '--bare', '--template=', '--initial-branch=main']);
  git(work, ['init', '--template=', '--initial-branch=main']);
  for (let push = 0; push < pushes; push++) {
    for (let file = 0; file < 5; file++)
      writeFileSync(join(work, `file-${file}.txt`), `push ${push} file ${file}\n`.repeat(200));
    git(work, ['add', '.']);
    git(work, ['commit', '-m', `Push ${push}`]);
    // Alternate: a pack kept as it arrived, then objects unpacked loose (Git's default for small pushes).
    const limit = push % 2 ? '100' : '1';
    git(repository, ['config', 'receive.unpackLimit', limit]);
    git(work, ['push', '-q', repository, 'main']);
  }
  return { id, repositoryPath: repository, work };
}
const bitmaps = (repository: string) =>
  readdirSync(join(repository, 'objects', 'pack')).filter((name) => name.endsWith('.bitmap'));

test('a repository left with loose objects, many packs and no bitmap is packed once', async () => {
  const project = pushed(6);
  const before = count(project.repositoryPath);
  assert.ok(before.count > 0 && before.packs > 1, JSON.stringify(before));
  assert.equal(await needsPacking(project.repositoryPath), true);

  assert.equal(await packRepository(project), true);
  const packed = count(project.repositoryPath);
  assert.equal(packed.count, 0);
  assert.ok(packed['in-pack'] >= before.count + before['in-pack'], JSON.stringify(packed));
  assert.ok(bitmaps(project.repositoryPath).some((name) => name.startsWith('multi-pack-index')));
  assert.equal(await needsPacking(project.repositoryPath), false);
  assert.equal(await packRepository(project), false, 'nothing to do the second time');
  git(project.repositoryPath, ['fsck', '--no-progress']);

  const clone = join(data, `clone-${project.id}`);
  git(data, ['clone', '-q', project.repositoryPath, clone]);
  assert.equal(git(clone, ['rev-list', '--count', 'HEAD']), '6');
  assert.match(logs.join('\n'), new RegExp(`Packed ${project.id}`));
});

test('a push after packing needs packing again, and the scheduled pack does it', async () => {
  const project = pushed(2);
  await packRepository(project);
  assert.equal(await needsPacking(project.repositoryPath), false);
  writeFileSync(join(project.work, 'later.txt'), 'later\n');
  git(project.work, ['add', '.']);
  git(project.work, ['commit', '-m', 'Later']);
  git(project.work, ['push', '-q', project.repositoryPath, 'main']);
  assert.equal(await needsPacking(project.repositoryPath), true);

  schedulePacking(project, 0);
  schedulePacking(project, 0); // A burst of pushes packs once.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await packingSettled();
  assert.equal(await needsPacking(project.repositoryPath), false);
  assert.equal(logs.filter((line) => line.includes(`Packed ${project.id} `)).length, 2);
});

test('the sweep packs every hosted repository that needs it and leaves empty ones alone', async () => {
  const first = pushed(3);
  const second = pushed(3);
  const empty = join(data, 'repositories', 'empty.git');
  mkdirSync(empty);
  git(empty, ['init', '--bare', '--template=', '--initial-branch=main']);
  assert.equal(await needsPacking(empty), false);

  // The earlier tests' repositories are packed already.
  assert.equal(await packAll(join(data, 'repositories')), 2);
  assert.equal(await needsPacking(first.repositoryPath), false);
  assert.equal(await needsPacking(second.repositoryPath), false);
  assert.equal(await packAll(join(data, 'repositories')), 0);
});
