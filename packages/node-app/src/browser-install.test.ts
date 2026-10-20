import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  browserInstallerCli,
  installChromium,
  browserInstallFailure,
} from '../../../bin/browser-install.mjs';

test('installer resolves the worker Playwright CLI and passes install args/cache without a shell', async () => {
  assert.match(browserInstallerCli(), /playwright\/cli\.js$/);
  const directory = mkdtempSync(join(tmpdir(), 'deploy-browser-installer-'));
  try {
    const cli = join(directory, 'fake cli.mjs');
    const cache = join(directory, 'user data', 'browsers');
    writeFileSync(
      cli,
      `import assert from 'node:assert/strict';
      assert.deepEqual(process.argv.slice(2), ['install', 'chromium']);
      assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, ${JSON.stringify(cache)});
      process.stdout.write('Downloading Chromium 25');
      setTimeout(() => process.stdout.write('%\\nprivate raw output\\n'), 10);
      `,
    );
    const stages: string[] = [];
    await installChromium({ cli, browsersPath: cache, onProgress: (stage) => stages.push(stage) });
    assert.ok(stages.includes('Downloading browser files… 25%'));
    assert.match(stages.at(-1)!, /installed/);
    assert.doesNotMatch(stages.join('\n'), /private raw output/);
    writeFileSync(
      cli,
      `console.error('secret URL: https://user:password@example.test ENOSPC'); process.exit(1);`,
    );
    await assert.rejects(installChromium({ cli }), /^Error: Not enough disk space/);
    await assert.rejects(
      installChromium({ cli, executable: join(directory, 'missing') }),
      /could not start/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('installer failures are one-line reasons and never raw output', () => {
  for (const [log, reason] of [
    ['EACCES private/path', /not writable/],
    ['ETIMEDOUT secrets', /network/],
    ['unexpected secrets', /installation failed/],
  ]) {
    const message = browserInstallFailure(log as string);
    assert.match(message, reason as RegExp);
    assert.doesNotMatch(message, /secrets|private/);
  }
});
