import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the managed worker is found from a shared chunk as well as from the server bundle', () => {
  // The bundler decides which file this module lands in. When it moved into a chunk under
  // dist/assets, a path relative to the module pointed at a file that does not exist, and the
  // coordinator's own task worker silently never started.
  const source = readFileSync(new URL('./managed-worker.ts', import.meta.url), 'utf8');
  assert.match(source, /packageWorkerFile\(import\.meta\.url, 'workspace-remote-worker\.js'/);
  assert.doesNotMatch(source, /new URL\(\s*[^)]*workspace-remote-worker\.js/);
});
