import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cloneTaskRepository, needsClone } from './task-clone.ts';

const folder = () => join(mkdtempSync(join(tmpdir(), 'task-clone-')), 'task');

test('a copy that fails leaves no folder, so the next try copies again', async () => {
  const path = folder();
  await assert.rejects(
    cloneTaskRepository(path, 'unused', {
      run: async (cwd) => {
        writeFileSync(join(cwd, 'half'), '');
        throw new Error("Cloning into '.'...\nfatal: unable to access: Could not resolve host");
      },
    }),
    /^Error: Could not copy the repository: fatal: unable to access: Could not resolve host$/,
  );
  assert.equal(existsSync(path), false);
  assert.equal(needsClone(path), true);
});

test('a copy that runs out of time says so instead of repeating what git printed first', async () => {
  const path = folder();
  await assert.rejects(
    cloneTaskRepository(path, 'unused', {
      timeout: 5,
      run: async () => {
        await new Promise((done) => setTimeout(done, 20));
        throw new Error("Cloning into '.'...\n");
      },
    }),
    /Copying the repository took longer than 0 minutes/,
  );
});

test('an empty folder from an earlier failure is copied into, and a real copy is kept', async () => {
  const source = mkdtempSync(join(tmpdir(), 'task-clone-source-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: source, stdio: 'pipe' });
  git(['init', '-q']);
  writeFileSync(join(source, 'file'), 'one');
  git(['add', '.']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'one']);
  const path = folder();
  mkdirSync(path, { recursive: true });
  assert.equal(needsClone(path), true);
  await cloneTaskRepository(path, source);
  assert.equal(existsSync(join(path, 'file')), true);
  assert.equal(needsClone(path), false);
});
