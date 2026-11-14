import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { root } from './test-import-graph.ts';

// Namespace wrappers are distinct objects; every exported binding must be the original
// singleton (including mutable caches and registered ports), never a second evaluation.
test('every repository compatibility path exposes the same module bindings', async () => {
  const data = mkdtempSync(join(tmpdir(), 'repository-compatibility-'));
  process.env.DEPLOY_DATA_DIR = data;
  try {
    for (const [oldPath, newPath] of [
      ['workspace/repositories.ts', 'features/repositories/repositories.ts'],
      ['workspace/repository-views.ts', 'features/repositories/repository-views.ts'],
      ['workspace/repository-creation.ts', 'features/repositories/repository-creation.ts'],
      [
        'workspace/repository-creation-worker.ts',
        'features/repositories/repository-creation-worker.ts',
      ],
      ['workspace/repository-lfs.ts', 'features/repositories/repository-lfs.ts'],
      ['workspace/repository-runner.ts', 'features/repositories/repository-runner.ts'],
      ['workspace/repository-search.ts', 'features/repositories/repository-search.ts'],
      ['workspace/repository-setup.ts', 'features/repositories/repository-setup.ts'],
      ['workspace/git-http.ts', 'features/repositories/git-http.ts'],
      ['workspace/git-ssh.ts', 'features/repositories/git-ssh.ts'],
      ['workspace/lfs-archive.ts', 'features/repositories/lfs-archive.ts'],
      ['workspace/lfs-checkout.ts', 'features/repositories/lfs-checkout.ts'],
      ['workspace/ssh-host.ts', 'features/repositories/ssh-host.ts'],
      ['workspace/ssh-keys.ts', 'features/repositories/ssh-keys.ts'],
      ['workspace/project-collaboration.ts', 'features/repositories/project-collaboration.ts'],
      ['workspace/project-tools.ts', 'features/repositories/project-tools.ts'],
      ['workspace/project-tool-schema.ts', 'features/repositories/project-tool-schema.ts'],
      ['v2/projects.ts', 'features/repositories/projects.ts'],
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
