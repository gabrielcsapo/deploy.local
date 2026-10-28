import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ReleaseRuntime } from './releases.ts';
const root = mkdtempSync(join(tmpdir(), 'release-recovery-'));
process.env.DEPLOY_DATA_DIR = root;
const { ProjectReleaseService, projectReleases, projectRollbacks } = await import('./releases.ts');
const { db, list } = await import('../workspace/store.ts');
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
for (const boundary of [
  'prepare',
  'partial',
  'published',
  'watch',
  'rollback-partial',
  'rollback-published',
  'rollback-watch',
]) {
  test(`SIGKILL at ${boundary} recovers a whole project and records the outcome`, async () => {
    db.prepare('DELETE FROM records').run();
    rmSync(join(root, 'published'), { force: true });
    rmSync(join(root, 'previous-live.json'), { force: true });
    const child = spawnSync(process.execPath, ['server/v2/releases-crash-fixture.ts', boundary], {
      env: { ...process.env, DEPLOY_DATA_DIR: root },
      encoding: 'utf8',
    });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    assert.equal(list('v2-project-run', 'owner').length, 1);
    const runtime: ReleaseRuntime = {
      async plan() {
        throw new Error('Recovery must use immutable receipts');
      },
      async prepare() {
        throw new Error('Recovery must not rebuild');
      },
      async verify() {
        throw new Error('Already verified');
      },
      async backup() {
        throw new Error('Unexpected backup');
      },
      async activate() {
        throw new Error('Published activation must not run twice');
      },
      async migrate() {},
      async watch() {},
      async rollback() {},
      async dispose() {},
      async recover() {
        if (existsSync(join(root, 'published'))) return 'activated';
        writeFileSync(
          join(root, 'live.json'),
          existsSync(join(root, 'previous-live.json'))
            ? readFileSync(join(root, 'previous-live.json'))
            : JSON.stringify({ web: 'old', sync: 'old' }),
        );
        return 'aborted';
      },
    };
    const recovered = new ProjectReleaseService(runtime, { watchMs: 0 });
    await recovered.recover();
    const release = projectReleases('owner', 'gym')[0];
    if (boundary.startsWith('rollback-')) {
      const rollback = projectRollbacks('owner', 'gym')[0];
      assert(rollback.steps.some((step) => /[Rr]ecover|restart/.test(step.detail || '')));
      assert.equal(release.state, boundary === 'rollback-partial' ? 'live' : 'rolled-back');
    } else
      assert.equal(release.state, ['published', 'watch'].includes(boundary) ? 'live' : 'failed');
    const live = JSON.parse(readFileSync(join(root, 'live.json'), 'utf8'));
    assert.equal(live.web, live.sync);
    if (!boundary.startsWith('rollback-'))
      assert(release.steps.some((step) => /[Rr]ecover|restart/.test(step.detail || '')));
    assert.equal(list('v2-project-run', 'owner').length, 0);
    await recovered.recover();
    assert.deepEqual(projectReleases('owner', 'gym')[0], release);
  });
}
