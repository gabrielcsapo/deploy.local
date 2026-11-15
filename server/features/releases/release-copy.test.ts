import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cloneArgs, copyAppData } from './release-copy.ts';

const root = mkdtempSync(join(tmpdir(), 'release-copy-'));
after(() => rmSync(root, { recursive: true, force: true }));

function library(name: string) {
  const from = join(root, name);
  mkdirSync(join(from, 'imports', 'books'), { recursive: true });
  writeFileSync(join(from, 'app.db'), 'rows', { mode: 0o600 });
  writeFileSync(join(from, 'imports', 'books', 'a.epub'), 'pages');
  symlinkSync('books/a.epub', join(from, 'imports', 'latest'));
  return from;
}

for (const platform of [process.platform, 'win32']) {
  test(`copies app data with modes and links intact (${platform})`, async () => {
    const from = library(`from-${platform}`);
    const to = join(root, `to-${platform}`);
    await copyAppData(from, to, platform as NodeJS.Platform);
    assert.equal(readFileSync(join(to, 'imports', 'books', 'a.epub'), 'utf8'), 'pages');
    assert.equal(statSync(join(to, 'app.db')).mode & 0o777, 0o600);
    assert.equal(readlinkSync(join(to, 'imports', 'latest')), 'books/a.epub');
    // The copy is independent of the original, cloned or not.
    writeFileSync(join(to, 'app.db'), 'changed');
    assert.equal(readFileSync(join(from, 'app.db'), 'utf8'), 'rows');
  });
}

test('never copies into an existing directory', async () => {
  const from = library('from-existing');
  const to = join(root, 'to-existing');
  mkdirSync(to);
  await assert.rejects(copyAppData(from, to), /already exists/);
});

test('clones where the system cp can', () => {
  assert.deepEqual(cloneArgs('darwin', 'a', 'b'), ['-c', '-R', '-p', 'a', 'b']);
  assert.ok(cloneArgs('linux', 'a', 'b')!.includes('--reflink=auto'));
  assert.equal(cloneArgs('win32', 'a', 'b'), null);
});
