import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { root } from './test-import-graph.ts';

// Namespace wrappers are distinct objects; every exported binding must be the original
// singleton (including mutable caches and registered ports), never a second evaluation.
test('every updates compatibility path exposes the same module bindings', async () => {
  const data = mkdtempSync(join(tmpdir(), 'updates-compatibility-'));
  process.env.DEPLOY_DATA_DIR = data;
  try {
    for (const [oldPath, newPath] of [
      ['v2/self-update-host.ts', 'features/updates/self-update-host.ts'],
      ['v2/update-admission.ts', 'features/updates/update-admission.ts'],
      ['v2/self-release-runtime.ts', 'features/updates/self-release-runtime.ts'],
      ['v2/fleet-updates.ts', 'features/updates/fleet-updates.ts'],
      ['v2/updates.ts', 'features/updates/updates.ts'],
      ['workspace/worker-update.ts', 'features/updates/worker-update.ts'],
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
