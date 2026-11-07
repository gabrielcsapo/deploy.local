import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageWorkerFile } from './worker-file.ts';

test('a worker is found beside its caller, one folder up, or from source', () => {
  const root = mkdtempSync(join(tmpdir(), 'worker-file-'));
  try {
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'w.mjs'), '');
    const from = (path: string) => pathToFileURL(join(root, path)).href;
    assert.equal(packageWorkerFile(from('server.js'), 'w.mjs', './s.mjs').href, from('w.mjs'));
    assert.equal(
      packageWorkerFile(from('assets/chunk.js'), 'w.mjs', './s.mjs').href,
      from('w.mjs'),
    );
    assert.equal(packageWorkerFile(from('server.js'), 'x.mjs', './s.mjs').href, from('s.mjs'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A release runs its tests after building. A worker the built code can't find fails every
// package that isn't kept yet, and running from source never shows it.
const dist = resolve('dist');
test('every built file can find the package workers it names', { skip: !existsSync(dist) }, () => {
  const workers = [
    'package-document-worker.mjs',
    'package-index-worker.mjs',
    'package-body-worker.mjs',
    'package-lock-worker.js',
    'package-recovery-worker.js',
    'backup-snapshot-worker.js',
  ];
  const files = [
    ...readdirSync(dist).map((name) => join(dist, name)),
    ...(existsSync(join(dist, 'assets'))
      ? readdirSync(join(dist, 'assets')).map((name) => join(dist, 'assets', name))
      : []),
  ].filter((file) => file.endsWith('.js'));
  const found = new Set<string>();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const worker of workers)
      if (text.includes(worker)) {
        found.add(worker);
        const url = packageWorkerFile(pathToFileURL(file).href, worker, './missing');
        assert.ok(existsSync(url), `${file} can't find ${worker}`);
      }
  }
  assert.deepEqual([...found].sort(), [...workers].sort());
});
