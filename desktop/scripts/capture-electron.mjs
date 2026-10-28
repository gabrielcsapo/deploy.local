import { _electron } from '../../node_modules/playwright/index.mjs';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {
  startFixture,
  styles,
  notificationContent,
  notificationCss,
} from '../../docs/evidence/v2/13-desktop-2/fixture-server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = fileURLToPath(
  new URL('../../docs/evidence/v2/13-desktop-2/native/', import.meta.url),
);
const require = createRequire(new URL('../package.json', import.meta.url));
await mkdir(output, { recursive: true });
const fixture = await startFixture();
try {
  for (const platform of ['darwin', 'linux']) {
    const directory = await mkdtemp(join(tmpdir(), 'deploy-desktop-capture-'));
    let electron;
    try {
      electron = await _electron.launch({
        executablePath: require('electron'),
        // Playwright picks ephemeral debugger ports; forcing both onto one port stalls the launch.
        args: [root],
        env: {
          ...process.env,
          DEPLOY_COORDINATOR_URL: 'http://127.0.0.1:5184',
          DEPLOY_DESKTOP_DATA_DIR: directory,
          DEPLOY_DESKTOP_FIXTURE: '1',
          DEPLOY_DESKTOP_FIXTURE_PLATFORM: platform,
          DEPLOY_DESKTOP_DISABLE_MDNS: '1',
          ELECTRON_ENABLE_LOGGING: '1',
        },
        timeout: 20000,
      });
      electron.process().stderr.on('data', (chunk) => process.stderr.write(chunk));
      const page = await electron.firstWindow();
      await page.emulateMedia({ colorScheme: 'light' });
      await page.getByRole('button', { name: 'Find coordinator' }).click();
      await page.getByLabel('Username').fill('fixture-owner');
      await page.getByLabel('Password').fill('fixture-password');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page
        .getByRole('heading', {
          name: `Let ${platform === 'linux' ? 'bazzite' : 'MacBook Pro'} help?`,
        })
        .waitFor();
      const capture = async (windowPage, name) => {
        await windowPage.evaluate(() => document.fonts.ready);
        await windowPage.screenshot({ path: join(output, `${name}.png`) });
      };
      await capture(page, platform === 'linux' ? 'SetupLinux' : 'Setup');
      if (platform === 'linux') continue;
      const show = (name) =>
        electron.evaluate((_electron, name) => globalThis.deployCaptureFixture(name), name);
      await show('Permissions');
      await page.getByRole('heading', { name: 'Let agents use the screen?' }).waitFor();
      await capture(page, 'Permissions');
      const trayPromise = electron.waitForEvent('window');
      await show('Tray');
      const tray = await trayPromise;
      await tray.emulateMedia({ colorScheme: 'light' });
      await tray.getByRole('switch', { name: 'Take new tasks' }).waitFor();
      await tray.getByRole('button', { name: /Roll back home-gym/ }).hover();
      await capture(tray, 'Tray');
      assert.equal(
        await tray
          .locator('body')
          .innerText()
          .then((text) => text.includes('!')),
        false,
      );
      await tray.getByRole('switch', { name: 'Take new tasks' }).uncheck();
      assert.equal(fixture.state.computers[1].roles.includes('take-tasks'), false);
      assert.equal(fixture.state.computers[1].doing.length, 1);
      await tray.getByRole('switch', { name: 'Take new tasks' }).check();
      const notificationPath = await show('Notification');
      const value = JSON.parse(await readFile(notificationPath, 'utf8'));
      await writeFile(join(output, 'Notification.json'), JSON.stringify(value, null, 2));
      const notificationPage = join(directory, 'notification.html');
      await writeFile(
        notificationPage,
        `<!doctype html><html data-ds-theme="light"><meta charset="utf-8"><style>${await styles()}${notificationCss}</style><body>${notificationContent(value)}</body></html>`,
      );
      const notePromise = electron.waitForEvent('window');
      await electron.evaluate(async ({ BrowserWindow }, path) => {
        const win = new BrowserWindow({
          width: 368,
          height: 200,
          frame: false,
          webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
        });
        await win.loadFile(path);
      }, notificationPage);
      await capture(await notePromise, 'Notification-content');
      fixture.state.offline = true;
      await show('Offline');
      await page.getByRole('heading', { name: "Can't reach SER" }).waitFor();
      await capture(page, 'Offline');
      assert.ok(!fixture.state.requests.some(({ path }) => path.includes('enroll')));
      await writeFile(
        join(output, 'requests.json'),
        JSON.stringify(fixture.state.requests, null, 2),
      );
    } finally {
      if (electron) await electron.close();
      await rm(directory, { recursive: true, force: true });
      fixture.state.offline = false;
    }
  }
} finally {
  await fixture.close();
}
