// Seeds a throwaway data folder with the boards' home-gym: a hosted repository with Git LFS
// files, a history with deleted files, a tag, and deploy.local's own task and review refs.
// Usage: DEPLOY_DATA_DIR=<empty folder> node --import tsx docs/evidence/repository-storage/seed.mts
// Prints the project id and a sign-in cookie value for the capture script.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (!process.env.DEPLOY_DATA_DIR) throw new Error('Set DEPLOY_DATA_DIR to an empty folder');
const store = await import('../../../server/store.ts');
const { createProject } = await import('../../../server/workspace/test-repository.ts');
const { db } = await import('../../../server/workspace/store.ts');

const owner = 'gabriel';
const { token } = store.registerUser(owner, 'fixture-password') as { token: string };
const project = createProject(owner, { name: 'home-gym' });
const repository = project.repositoryPath;
const work = join(process.env.DEPLOY_DATA_DIR, 'seed-work');
execFileSync('git', ['clone', '-q', repository, work]);
const MB = 1024 * 1024;
const day = 86400000;
let clock = Date.now() - 420 * day;
function git(...args: string[]) {
  return execFileSync('git', ['-C', work, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Gabriel',
      GIT_AUTHOR_EMAIL: 'gabriel@example.invalid',
      GIT_COMMITTER_NAME: 'Gabriel',
      GIT_COMMITTER_EMAIL: 'gabriel@example.invalid',
      GIT_AUTHOR_DATE: new Date(clock).toISOString(),
      GIT_COMMITTER_DATE: new Date(clock).toISOString(),
    },
  }).trim();
}
function write(path: string, content: string | Buffer) {
  mkdirSync(join(work, path, '..'), { recursive: true });
  writeFileSync(join(work, path), content);
}
function commit(message: string, daysAgo: number) {
  clock = Date.now() - daysAgo * day;
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', message);
}
function lfs(path: string, size: number) {
  const bytes = Math.round(size);
  const content = randomBytes(bytes);
  const oid = createHash('sha256').update(content).digest('hex');
  const folder = join(repository, 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, oid), content);
  write(path, `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${bytes}\n`);
}
// Text that compresses like source does, so history sizes look like a real project's.
const text = (lines: number) =>
  Array.from(
    { length: lines },
    (_, i) => `${i} ${randomBytes(12).toString('hex')} workouts sets reps`,
  ).join('\n');

write('package.json', '{ "name": "home-gym" }\n');
lfs('assets/img/hero-raw.tiff', 9 * MB);
lfs('assets/img/plates-raw.tiff', 6 * MB);
lfs('data/exercises-2023.sqlite', 5 * MB);
write('dist/bundle.js', randomBytes(Math.round(1.4 * MB)));
commit('Start home-gym', 400);
lfs('data/exercises-2024.sqlite', 9.6 * MB);
write('docs/screens/dashboard.png', randomBytes(Math.round(1.7 * MB)));
write('pnpm-lock.yaml', text(9000));
commit('Exercise data', 240);
lfs('assets/video/form-check-deadlift.mov', 8.8 * MB);
lfs('design/source/app-icons.psd', 14.8 * MB);
commit('Form check videos', 210);
lfs('assets/audio/timer-voices.zip', 4.4 * MB);
lfs('assets/audio/beep-set.wav', 4 * MB);
lfs('assets/video/form-check-squat.mov', 28.6 * MB);
commit('Timer voices', 120);
for (let i = 0; i < 24; i++) {
  write('package-lock.json', text(4000 + i * 40));
  write('fixtures/workouts.json', text(1500 + i * 10));
  write(`app/routes/workouts.tsx`, text(300 + i));
  commit(`Workouts ${i + 1}`, 100 - i * 4);
}
git('rm', '-q', 'dist/bundle.js', 'docs/screens/dashboard.png', 'pnpm-lock.yaml');
git('rm', '-q', 'assets/video/form-check-deadlift.mov');
commit('Drop build output and the deadlift video', 60);
git('tag', 'v1.0.0');
lfs('assets/video/onboarding.mp4', 41.2 * MB);
lfs('assets/img/coach.png', 2 * MB);
lfs('assets/img/badge.png', 1 * MB);
lfs('assets/audio/countdown.wav', 3 * MB);
write('package-lock.json', text(5200));
commit('Onboarding video', 21);
write('app/routes/workouts.tsx', text(420));
commit('Yesterday', 1);
git('push', '-q', 'origin', 'main', 'v1.0.0');
// deploy.local's own refs: tasks, checkpoints and design reviews hold work no branch has.
for (let i = 0; i < 5; i++) {
  git('checkout', '-q', '--detach', 'main');
  write(`task-${i}.json`, text(2000));
  commit(`Task ${i}`, 3);
  const ref =
    i < 4 ? `refs/deploy/tasks/task-${i}` : `refs/deploy/design-reviews/${'r'.repeat(40)}`;
  git('push', '-q', 'origin', `HEAD:${ref}`);
}
db.close();
console.log(JSON.stringify({ project: project.id, cookie: encodeURIComponent(`${owner}:${token}`) }));
