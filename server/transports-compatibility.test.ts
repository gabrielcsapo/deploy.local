import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { root } from './test-import-graph.ts';

// Namespace wrappers are distinct objects; every exported binding must be the original
// singleton (including mutable caches and registered ports), never a second evaluation.
test('every transports compatibility path exposes the same module bindings', async () => {
  const data = mkdtempSync(join(tmpdir(), 'transports-compatibility-'));
  process.env.DEPLOY_DATA_DIR = data;
  try {
    for (const [oldPath, newPath] of [
      ['workspace/api.ts', 'transports/workspace/api.ts'],
      ['workspace/coordination-api.ts', 'transports/workspace/coordination-api.ts'],
      ['workspace/mcp-stdio.ts', 'transports/workspace/mcp-stdio.ts'],
      ['workspace/operation-signature.ts', 'transports/workspace/operation-signature.ts'],
      ['workspace/recording-upload.ts', 'transports/workspace/recording-upload.ts'],
      ['workspace/terminal-socket.ts', 'transports/workspace/terminal-socket.ts'],
      ['v2/auth.ts', 'transports/v2/auth.ts'],
      ['v2/dashboard-page.ts', 'transports/v2/dashboard-page.ts'],
      ['v2/diagnostics.ts', 'transports/v2/diagnostics.ts'],
      ['v2/logs.ts', 'transports/v2/logs.ts'],
      ['v2/performance.ts', 'transports/v2/performance.ts'],
      ['v2/project-page.ts', 'transports/v2/project-page.ts'],
      ['v2/projects-api.ts', 'transports/v2/projects-api.ts'],
      ['v2/pull-files.ts', 'transports/v2/pull-files.ts'],
      ['v2/push.ts', 'transports/v2/push.ts'],
      ['v2/requests.ts', 'transports/v2/requests.ts'],
      ['v2/search.ts', 'transports/v2/search.ts'],
      ['v2/start.ts', 'transports/v2/start.ts'],
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
