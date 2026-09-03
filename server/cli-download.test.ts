import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cliBinaryFilename } from './cli-download.ts';

describe('standalone CLI artifact names', () => {
  it('matches Node platform identifiers and keeps the Windows executable suffix', () => {
    assert.equal(cliBinaryFilename('darwin', 'arm64'), 'deploy-darwin-arm64');
    assert.equal(cliBinaryFilename('linux', 'x64'), 'deploy-linux-x64');
    assert.equal(cliBinaryFilename('win32', 'x64'), 'deploy-win32-x64.exe');
  });
});
