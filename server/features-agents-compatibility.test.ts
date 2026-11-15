import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { root } from './test-import-graph.ts';

// Namespace wrappers are distinct objects; every exported binding must be the original
// singleton (including mutable caches and registered ports), never a second evaluation.
test('every agents compatibility path exposes the same module bindings', async () => {
  const data = mkdtempSync(join(tmpdir(), 'agents-compatibility-'));
  process.env.DEPLOY_DATA_DIR = data;
  try {
    for (const [oldPath, newPath] of [
      ['workspace/agent-context.ts', 'features/agents/agent-context.ts'],
      ['workspace/agent-launch.ts', 'features/agents/agent-launch.ts'],
      ['workspace/agent-media.ts', 'features/agents/agent-media.ts'],
      ['workspace/agent-packages.ts', 'features/agents/agent-packages.ts'],
      ['workspace/claude-stream.ts', 'features/agents/claude-stream.ts'],
      ['workspace/compatible-control-tools.ts', 'features/agents/compatible-control-tools.ts'],
      ['workspace/coordination.ts', 'features/agents/coordination.ts'],
      ['workspace/coordination-tools.ts', 'features/agents/coordination-tools.ts'],
      ['workspace/design-tool-schema.ts', 'features/agents/design-tool-schema.ts'],
      ['workspace/model-options.ts', 'features/agents/model-options.ts'],
      ['workspace/provider-runtime.ts', 'features/agents/provider-runtime.ts'],
      ['workspace/provider-usage.ts', 'features/agents/provider-usage.ts'],
      ['workspace/shipping-instructions.ts', 'features/agents/shipping-instructions.ts'],
      ['v2/agent-foundation.ts', 'features/agents/agent-foundation.ts'],
      ['v2/agent-instructions.ts', 'features/agents/agent-instructions.ts'],
      ['v2/agents.ts', 'features/agents/agents.ts'],
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
