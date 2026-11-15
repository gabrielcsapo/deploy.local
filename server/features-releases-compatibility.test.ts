import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { root } from './test-import-graph.ts';

// Namespace wrappers are distinct objects; every exported binding must be the original
// singleton (including mutable caches and registered ports), never a second evaluation.
test('every releases compatibility path exposes the same module bindings', async () => {
  const data = mkdtempSync(join(tmpdir(), 'releases-compatibility-'));
  process.env.DEPLOY_DATA_DIR = data;
  try {
    for (const [oldPath, newPath] of [
      ['workspace/application-deployment.ts', 'features/releases/application-deployment.ts'],
      ['workspace/pipeline-deployment.ts', 'features/releases/pipeline-deployment.ts'],
      ['workspace/pipelines.ts', 'features/releases/pipelines.ts'],
      ['v2/project-policy.ts', 'features/releases/project-policy.ts'],
      ['v2/project-removal.ts', 'features/releases/project-removal.ts'],
      ['v2/release-build-log.ts', 'features/releases/release-build-log.ts'],
      ['v2/release-copy.ts', 'features/releases/release-copy.ts'],
      ['v2/release-progress.ts', 'features/releases/release-progress.ts'],
      ['v2/release-shared-data.ts', 'features/releases/release-shared-data.ts'],
      ['v2/releases-fence.ts', 'features/releases/releases-fence.ts'],
      ['v2/releases-plan.ts', 'features/releases/releases-plan.ts'],
      ['v2/releases-remote.ts', 'features/releases/releases-remote.ts'],
      ['v2/releases-runtime.ts', 'features/releases/releases-runtime.ts'],
      ['v2/releases-upload.ts', 'features/releases/releases-upload.ts'],
    ]) {
      const oldModule = await import(pathToFileURL(join(root, 'server', oldPath)).href);
      const newModule = await import(pathToFileURL(join(root, 'server', newPath)).href);
      assert.deepEqual(Object.keys(oldModule), Object.keys(newModule), oldPath);
      for (const name of Object.keys(newModule))
        assert.equal(oldModule[name], newModule[name], `${oldPath}: ${name}`);
    }
  } finally {
    const workspace = await import('./workspace/store.ts');
    const engine = await import('./store.ts');
    workspace.db.close();
    engine._resetDb();
    rmSync(data, { recursive: true, force: true });
  }
});
