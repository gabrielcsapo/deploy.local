import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('retired Suitcase commands use the unknown-command exit and error contract', () => {
  for (const command of ['suitcase', 'fleet', 'unknown-retired-command']) {
    const result = spawnSync(
      process.execPath,
      ['bin/deploy.js', command, '--json', '--server', 'http://127.0.0.1:1'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 2, result.stderr);
    const output = JSON.parse(result.stderr);
    assert.match(output.error.message, new RegExp(`Unknown command "${command}"`));
    assert.equal(output.exitCode, 2);
  }
});
