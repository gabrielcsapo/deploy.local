import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeJobFolder } from './job-runner.ts';

test('a job folder the worker cannot delete is emptied by the image the job ran in', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root can delete anything');
  const root = mkdtempSync(join(tmpdir(), 'job-folder-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  // Stands in for Docker: records its arguments and deletes as the container's root would.
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh\necho "$@" > "${root}/docker.args"\nfor a in "$@"; do case "$a" in *:/workspace) d="\${a%:/workspace}"; chmod -R u+w "$d"; rm -rf "$d"/* "$d"/.[!.]*;; esac; done\n`,
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  process.env.PATH = bin + ':' + path;
  try {
    const plain = join(root, 'plain-1');
    mkdirSync(join(plain, 'src'), { recursive: true });
    await removeJobFolder(plain);
    assert.equal(existsSync(plain), false);
    assert.equal(
      existsSync(join(root, 'docker.args')),
      false,
      'no container for an ordinary folder',
    );

    const owned = join(root, 'owned-1');
    mkdirSync(join(owned, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(owned, 'node_modules', 'pkg', 'index.js'), '');
    chmodSync(join(owned, 'node_modules', 'pkg'), 0o500);
    chmodSync(join(owned, 'node_modules'), 0o500);
    writeFileSync(owned + '.container', 'node:26\n');
    await removeJobFolder(owned);
    assert.equal(existsSync(owned), false);
    assert.equal(existsSync(owned + '.container'), false);
    assert.match(
      readFileSync(join(root, 'docker.args'), 'utf8'),
      /--entrypoint \/bin\/sh .*owned-1:\/workspace node:26 /,
    );
  } finally {
    process.env.PATH = path;
    rmSync(root, { recursive: true, force: true });
  }
});
