import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { root } from './test-import-graph.ts';

// Namespace wrappers are distinct objects; every exported binding must be the original
// singleton (including mutable caches and registered ports), never a second evaluation.
test('every decisions compatibility path exposes the same module bindings', async () => {
  const data = mkdtempSync(join(tmpdir(), 'decisions-compatibility-'));
  process.env.DEPLOY_DATA_DIR = data;
  try {
    for (const [oldPath, newPath] of [
      ['workspace/control-continuation.ts', 'features/decisions/control-continuation.ts'],
      ['workspace/question-continuation.ts', 'features/decisions/question-continuation.ts'],
      ['workspace/question-lifecycle.ts', 'features/decisions/question-lifecycle.ts'],
      ['workspace/questions.ts', 'features/decisions/questions.ts'],
      ['v2/inbox.ts', 'features/decisions/inbox.ts'],
      ['v2/phone-preferences.ts', 'features/decisions/phone-preferences.ts'],
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
