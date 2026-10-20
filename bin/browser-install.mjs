import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { isSea } from 'node:sea';
import { resolve, dirname, join } from 'node:path';

/** Resolve the CLI beside the importing worker/app, using its exact Playwright version. */
export function browserInstallerCli() {
  const require = createRequire(isSea() ? resolve('package.json') : import.meta.url);
  try {
    return join(dirname(require.resolve('playwright/package.json')), 'cli.js');
  } catch {
    throw new Error(
      'Playwright is missing. Run deploy browser install from the worker installation.',
    );
  }
}

/** Only bounded, plain-language stages cross into the setup renderer; never raw CLI output. */
export function browserInstallProgress(line) {
  const percent = line.match(/\b(100|\d{1,2})%/);
  if (percent) return `Downloading browser files… ${percent[1]}%`;
  if (/download/i.test(line)) return 'Downloading browser files…';
  if (/extract|unzip/i.test(line)) return 'Unpacking browser files…';
  return null;
}

export function browserInstallFailure(output) {
  if (/ENOSPC|no space left/i.test(output)) return 'Not enough disk space to install Chromium.';
  if (/EACCES|permission denied/i.test(output)) return 'Chromium’s install folder is not writable.';
  if (/ENOTFOUND|ECONN|ETIMEDOUT|certificate|download failure/i.test(output))
    return 'Chromium could not download. Check this computer’s network and retry.';
  return 'Chromium installation failed. Retry or check the worker’s system dependencies.';
}

/** CLI/managed workers keep Playwright's normal cache (or their explicit environment override).
 * The app supplies its userData path here and in the worker environment. No shell or pnpm.
 */
export async function installChromium({
  cli = browserInstallerCli(),
  executable = isSea() ? 'node' : process.execPath,
  browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH,
  env = process.env,
  onProgress = () => {},
} = {}) {
  onProgress('Preparing Chromium…');
  await new Promise((resolveInstall, reject) => {
    const child = spawn(executable, [cli, 'install', 'chromium'], {
      env: {
        ...env,
        ...(browsersPath ? { PLAYWRIGHT_BROWSERS_PATH: browsersPath } : {}),
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let pending = '';
    const read = (chunk) => {
      output = (output + chunk.toString()).slice(-16000);
      pending += chunk.toString();
      const lines = pending.split(/[\r\n]/);
      pending = lines.pop().slice(-2000);
      for (const line of lines) {
        const stage = browserInstallProgress(line);
        if (stage) onProgress(stage);
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('error', () => reject(new Error('The Chromium installer could not start.')));
    child.once('close', (code) => {
      if (code === 0) resolveInstall();
      else reject(new Error(browserInstallFailure(output)));
    });
  });
  onProgress('Chromium installed.');
}
