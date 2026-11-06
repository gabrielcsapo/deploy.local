import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import git, {
  gitEnvironment,
  gitRead,
  gitResultSync,
  gitStringSync,
  gitSync,
  gitText,
} from './git.ts';

test('async and synchronous small reads agree on output, missing refs and cwd', async () => {
  const root = mkdtempSync(join(tmpdir(), 'deploy-git-'));
  try {
    assert.equal(gitResultSync(root, ['init', '--quiet']).status, 0);
    writeFileSync(join(root, 'file'), 'line\n\n');
    const oid = gitStringSync(root, ['hash-object', '-w', 'file']);
    const args = ['cat-file', 'blob', oid];
    assert.equal((await git(root, args)).toString(), 'line\n\n');
    assert.equal(await gitText(root, args), 'line');
    assert.equal(await gitRead(root, args), gitSync(root, args));
    assert.equal(await gitRead(root, ['rev-parse', '--verify', 'absent']), null);
    assert.equal(gitSync(root, ['rev-parse', '--verify', 'absent']), null);
    assert.equal(gitStringSync(root, args, { trim: 'none' }), 'line\n\n');
    await assert.rejects(git(root, args, { limit: 1 }), {
      message: 'Repository response exceeds the size limit',
      status: 413,
    });
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      git(root, args, { signal: abort.signal }),
      /Repository operation cancelled/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy Git options preserve identity environment, stdin, trimming and fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'deploy-git-options-'));
  try {
    gitStringSync(root, ['init', '--quiet']);
    const oid = gitStringSync(root, ['hash-object', '-w', '--stdin'], {
      input: '  x \n',
      env: process.env,
    });
    assert.equal(gitStringSync(root, ['cat-file', 'blob', oid], { trim: 'both' }), 'x');
    assert.equal(gitStringSync(root, ['cat-file', 'blob', oid]), '  x');
    assert.throws(
      () =>
        gitStringSync(root, ['rev-parse', '--verify', '--quiet', 'absent'], {
          fallback: 'Git checkpoint failed',
        }),
      { message: 'Git checkpoint failed' },
    );
    const env = gitEnvironment();
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.GIT_LFS_SKIP_SMUDGE, '1');
    assert.equal(env.GCM_INTERACTIVE, 'never');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
