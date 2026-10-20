import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { removeLegacyTray } from '../src/linux-service.ts';
if (process.platform !== 'linux') throw new Error('Node app installation is Linux only');
const here = fileURLToPath(new URL('..', import.meta.url));
const entry = fileURLToPath(new URL('start.mjs', import.meta.url));
const autostart = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
  'autostart/deploy-node.desktop',
);
const command = process.argv[2];
if (command === 'uninstall') {
  rmSync(autostart, { force: true });
  console.log(
    'Login startup removed. Quit deploy.local Node from its tray; helpers and enrollment are retained.',
  );
} else if (command === 'status')
  console.log(
    `deploy.local Node login startup: ${existsSync(autostart) ? 'enabled' : 'disabled'}. Run deploy agent status --json for worker status.`,
  );
else if (['build', 'install'].includes(command)) {
  const build = spawnSync(process.execPath, [join(here, 'build.mjs')], { stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);
  if (command === 'install') {
    await removeLegacyTray();
    const child = spawn(process.execPath, [entry, '--setup'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, DEPLOY_NODE_ENABLE_AUTOSTART: '1' },
    });
    child.unref();
    console.log('Started deploy.local Node setup. Login startup is enabled after enrollment.');
  }
} else throw new Error('Usage: node scripts/menubar.mjs <build|install|uninstall|status>');
