import assert from 'node:assert/strict';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { rotateLogIfLarge } from './log-rotation.ts';

test('a log at its cap is copied aside and emptied in place, keeping a bounded history', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'log-rotation-'));
  const path = join(root, 'server.log');
  // Append mode, as systemd and launchd open it.
  const fd = openSync(path, 'a');
  t.after(() => {
    closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  });
  const rotate = () => rotateLogIfLarge({ fd, path, maxBytes: 10, keep: 2 });

  writeSync(fd, 'short');
  assert.equal(rotate(), false);

  writeSync(fd, ' first-full');
  assert.equal(rotate(), true);
  assert.equal(readFileSync(`${path}.1`, 'utf8'), 'short first-full');
  assert.equal(readFileSync(path, 'utf8'), '');

  // The same descriptor keeps writing, from the start of the emptied file.
  writeSync(fd, 'second-full');
  assert.equal(readFileSync(path, 'utf8'), 'second-full');
  assert.equal(rotate(), true);
  writeSync(fd, 'third-full!');
  assert.equal(rotate(), true);
  assert.equal(readFileSync(`${path}.1`, 'utf8'), 'third-full!');
  assert.equal(readFileSync(`${path}.2`, 'utf8'), 'second-full');
  assert.equal(existsSync(`${path}.3`), false);
});

test('a descriptor that is not the named file is left alone', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'log-rotation-'));
  const path = join(root, 'server.log');
  const other = join(root, 'other.log');
  const fd = openSync(other, 'a');
  const named = openSync(path, 'a');
  t.after(() => {
    closeSync(fd);
    closeSync(named);
    rmSync(root, { recursive: true, force: true });
  });
  writeSync(fd, 'x'.repeat(100));
  writeSync(named, 'y'.repeat(100));
  assert.equal(rotateLogIfLarge({ fd, path, maxBytes: 10 }), false);
  assert.equal(readFileSync(other, 'utf8').length, 100);
  assert.equal(existsSync(`${path}.1`), false);
});
