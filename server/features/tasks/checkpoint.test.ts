import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateSnapshot, type Snapshot } from './checkpoint.ts';
function snapshot(paths: string[]): Snapshot {
  const files = paths
    .map((path) => ({ path, content: Buffer.from('data').toString('base64'), executable: false }))
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return {
    files,
    excluded: [],
    digest: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
  };
}
test('cross-machine checkpoints reject private path aliases and case/Unicode file collisions before creating a workspace', () => {
  for (const path of ['.NPMRC', '.GiT/config', 'config/.SSH/id', 'config/.EnV.local'])
    assert.throws(() => validateSnapshot(snapshot([path])), /Unsafe/);
  for (const paths of [
    ['Readme', 'README'],
    ['café.txt', 'cafe\u0301.txt'],
    ['Source', 'source/index.ts'],
  ])
    assert.throws(() => validateSnapshot(snapshot(paths)), /Unsafe|collision/);
  assert.equal(validateSnapshot(snapshot(['src/main.ts', 'README.md'])).files.length, 2);
  assert.throws(
    () => validateSnapshot({ files: [null], excluded: [], digest: '' } as unknown as Snapshot),
    /Unsafe/,
  );
});
