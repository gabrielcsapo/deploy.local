import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
if (process.platform !== 'linux') {
  console.error('deploy.local Node runs on Linux only. Use the native Deploy app on macOS.');
  process.exit(1);
}
const electron = createRequire(import.meta.url)('electron');
const child = spawn(
  electron,
  [fileURLToPath(new URL('..', import.meta.url)), ...process.argv.slice(2)],
  { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } },
);
child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', () => process.exit(1));
