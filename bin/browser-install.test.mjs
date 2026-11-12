import assert from 'node:assert/strict';
import test from 'node:test';
import { installChromium } from './browser-install.mjs';

test('managed Chromium installation has a finite download limit and never reports timeout as success', async () => {
  const stages = [];
  await assert.rejects(
    installChromium({
      cli: '/fixture/playwright.js',
      onProgress: (stage) => stages.push(stage),
      run: async (_command, _args, options) => {
        assert.equal(options.timeoutMs, 30 * 60_000);
        options.onOutput('Downloading files 20%\n');
        return { status: null, timedOut: true, stdout: '', stderr: 'timed out' };
      },
    }),
    /Chromium installation failed/,
  );
  assert.deepEqual(stages, ['Preparing Chromium…', 'Downloading browser files… 20%']);
});
