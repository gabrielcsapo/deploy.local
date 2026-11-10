import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { taskShellDirectory, createShellCommand } from './task-shell.ts';
test('worker resolves only opaque task ids and reports missing folders', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-shell-'));
  mkdirSync(join(root, 'tasks', 'task'), { recursive: true });
  assert.equal(taskShellDirectory(root, 'task').cwd, join(root, 'tasks', 'task'));
  assert.equal(taskShellDirectory(root, 'missing').cwd, homedir());
  assert.match(taskShellDirectory(root, 'missing').notice, /home directory/);
  for (const id of ['..', '../escape', '/tmp', 'a/b'])
    assert.throws(() => taskShellDirectory(root, id), /Invalid/);
});
test('noninteractive command has closed stdin and propagates exit code', async () => {
  const child = createShellCommand('read value; test -t 0; exit 9', tmpdir());
  const [result] = await once(child, 'exit');
  assert.equal(result.code, 9);
});
test('Stop and timeout kill the separate command process group', async () => {
  for (const timeout of [true, false]) {
    const child = createShellCommand('sleep 60 & wait', tmpdir(), timeout ? 50 : 600000);
    const done = once(child, 'exit');
    if (!timeout) child.kill();
    const [result] = await done;
    assert.equal(result.code, null);
    assert.throws(() => process.kill(child.pid!, 0), /ESRCH/);
  }
});

test('task shells follow the resumed workspace and validate its generation', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-shell-moved-'));
  mkdirSync(join(root, 'tasks', 'task-moved'), { recursive: true });
  assert.equal(taskShellDirectory(root, 'task', 'moved').cwd, join(root, 'tasks', 'task-moved'));
  assert.throws(() => taskShellDirectory(root, 'task', '../escape'), /Invalid workspace/);
});
