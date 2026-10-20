import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, shell, Tray } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readAgentConfig, joinAgent, userAgentConfigPath } from '../../../bin/agent-enrollment.mjs';
import { runDesktopHelper } from '../../../bin/desktop-helper.mjs';
import { desktopRequest } from '../../../server/workspace/linux-desktop.ts';
import { readNodeSnapshot, readNodeStatus } from '../../../server/workspace/node-status.ts';
import { controlPaused, setControlPaused } from '../../../server/workspace/node-control.ts';
import tokens from '../../../app/design-tokens.json' with { type: 'json' };
import { trayModel } from './tray-model.ts';
import type { TrayAction, TrayItem } from './tray-model.ts';
import {
  autostartEnabled,
  controlServer,
  readBundledHelper,
  readJournal,
  removeLegacyTray,
  setAutostart,
} from './linux-service.ts';
import { SupervisorMonitor, socketFromServerUnit } from './supervisor.ts';
import { trustedSetupOrigin, setupNavigation, redactLogs } from './setup-policy.ts';

const exec = promisify(execFile);
const directory = import.meta.dirname;
const configPath = process.env.DEPLOY_AGENT_CONFIG || userAgentConfigPath();
if (process.platform === 'linux') {
  app.setName('deploy.local Node');
  app.setPath('userData', join(app.getPath('appData'), 'deploy.local Node'));
}
let setup: BrowserWindow | undefined;
let tray: Tray | undefined;
let worker: ChildProcess | undefined;
let monitor: SupervisorMonitor | undefined;
let quitting = false;
let refreshing = false;
let refreshTimer: ReturnType<typeof setInterval>;
const launcher = () => {
  const command = app.isPackaged
    ? [process.env.APPIMAGE || process.execPath]
    : [process.execPath, resolve(directory, '..')];
  const environment = [
    'DEPLOY_AGENT_CONFIG',
    'DEPLOY_CONTROL_PAUSE_FILE',
    'DEPLOY_NODE_STATUS_PATH',
    'DEPLOY_COORDINATOR_URL',
    'DEPLOY_NODE_SETUP_PATH',
    'DEPLOY_SUPERVISOR_SOCKET',
    'DEPLOY_DATA_DIR',
    'DEPLOY_BROWSER_CONTROL',
  ]
    .filter((key) => process.env[key])
    .map((key) => `${key}=${process.env[key]}`);
  return environment.length ? ['/usr/bin/env', ...environment, ...command] : command;
};
async function supervisorSocket() {
  if (process.env.DEPLOY_SUPERVISOR_SOCKET) return process.env.DEPLOY_SUPERVISOR_SOCKET;
  if (process.env.DEPLOY_DATA_DIR) return resolve(process.env.DEPLOY_DATA_DIR, 'supervisor.sock');
  try {
    const { stdout } = await exec('systemctl', [
      'show',
      '-p',
      'Environment',
      '-p',
      'WorkingDirectory',
      'deploy-server.service',
    ]);
    const socket = socketFromServerUnit(stdout);
    if (socket) return socket;
  } catch {
    /* this machine may only run a worker */
  }
  return resolve(directory, '../../../.deploy-data/supervisor.sock');
}
const coordinator = () =>
  readAgentConfig(configPath)?.coordinatorUrl ||
  process.env.DEPLOY_COORDINATOR_URL ||
  readNodeSnapshot()?.coordinatorUrl ||
  'https://deploy.local';
const localUrl = pathToFileURL(join(directory, 'setup.html')).href;
async function status() {
  return {
    node: await readNodeStatus({
      config: readAgentConfig(configPath),
      helper: async () => JSON.parse(await runDesktopHelper('status', { json: true })),
    }),
    autostart: autostartEnabled(),
  };
}
function icon(color: 'green' | 'orange' | 'red') {
  const value =
    tokens.color.dark[{ green: 'success', orange: 'warning', red: 'danger' }[color] as 'success'];
  const rgb = [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  const bitmap = Buffer.alloc(22 * 22 * 4);
  for (let y = 0; y < 22; y++)
    for (let x = 0; x < 22; x++)
      if ((x - 10.5) ** 2 + (y - 10.5) ** 2 < 49) {
        const offset = (y * 22 + x) * 4;
        bitmap.set([rgb[2], rgb[1], rgb[0], 255], offset);
      }
  return nativeImage.createFromBitmap(bitmap, { width: 22, height: 22, scaleFactor: 1 });
}
async function safeExternal(value: string) {
  const url = new URL(value);
  if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password)
    await shell.openExternal(url.href);
}
const allowed = (url: string) => trustedSetupOrigin(url, coordinator(), localUrl);
const canNavigate = (url: string) =>
  setupNavigation(url, coordinator(), localUrl, process.env.DEPLOY_NODE_SETUP_PATH);
async function openSetup(step = '', reload = false) {
  if (setup && !step && !reload) {
    setup.show();
    setup.focus();
    return;
  }
  if (!setup) {
    setup = new BrowserWindow({
      width: 420,
      height: 640,
      resizable: true,
      title: 'deploy.local Node setup',
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(directory, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
      },
    });
    setup.on('closed', () => {
      setup = undefined;
    });
    setup.webContents.setWindowOpenHandler(({ url }) => {
      void safeExternal(url);
      return { action: 'deny' };
    });
    setup.webContents.on('will-navigate', (event, url) => {
      if (!canNavigate(url)) {
        event.preventDefault();
        void safeExternal(url);
      }
    });
    setup.webContents.on('will-redirect', (event, url) => {
      if (!canNavigate(url)) event.preventDefault();
    });
    setup.webContents.on('will-frame-navigate', (event) => {
      if (!canNavigate(event.url)) event.preventDefault();
    });
    setup.webContents.on('will-attach-webview', (event) => event.preventDefault());
    setup.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
  }
  setup.show();
  setup.focus();
  const node = (await status()).node;
  if (!node.workerId) {
    await setup.loadURL(localUrl);
    return;
  }
  const path =
    process.env.DEPLOY_NODE_SETUP_PATH ||
    `/dashboard/embed/computers/${encodeURIComponent(node.workerId)}`;
  const url = new URL(path, coordinator());
  if (url.origin !== new URL(coordinator()).origin)
    throw new Error('DEPLOY_NODE_SETUP_PATH must be on the coordinator origin');
  if (step) url.hash = `permission-${step}`;
  try {
    await setup.loadURL(url.href);
  } catch {
    if (setup && !setup.isDestroyed()) await setup.loadURL(localUrl);
  }
}
function startWorker() {
  if (worker || quitting) return;
  const config = readAgentConfig(configPath);
  if (!config?.workerToken || !config.workerId) return;
  const root = join(app.getPath('userData'), 'worker');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const logPath = join(root, 'worker.log');
  let logSize = 0;
  try {
    logSize = statSync(logPath).size;
  } catch {
    /* first run */
  }
  // Start a fresh log past 5 MB so a crash loop can't fill the disk.
  const log = openSync(logPath, logSize > 5_000_000 ? 'w' : 'a', 0o600);
  worker = spawn(process.execPath, [join(directory, 'workspace-remote-worker.js')], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DEPLOY_WORKER_ID: config.workerId,
      DEPLOY_WORKER_TOKEN: config.workerToken,
      DEPLOY_WORKER_NAME: config.name,
      DEPLOY_COORDINATOR_URL: config.coordinatorUrl,
      DEPLOY_WORKER_ROOT: root,
      DEPLOY_DATA_DIR: join(root, 'data'),
      DEPLOY_BROWSER_CONTROL: process.env.DEPLOY_BROWSER_CONTROL || '1',
      // As plain Node, the worker ignores the OS trust store unless asked; coordinators on a
      // private CA (deploy.local) are trusted through it, as the setup window already is.
      NODE_USE_SYSTEM_CA: '1',
    },
    // Worker output may contain provider text, so it never reaches the tray. It goes to a
    // private log for diagnosis instead of being discarded.
    stdio: ['ignore', log, log],
  });
  closeSync(log);
  worker.on('error', () =>
    console.error('Task worker could not start; check the installed Node app.'),
  );
  worker.on('exit', () => {
    worker = undefined;
    if (!quitting) setTimeout(startWorker, 5000);
  });
}
async function confirm(message: string, detail: string, confirmLabel: string) {
  const options = {
    type: 'warning' as const,
    message,
    detail,
    buttons: ['Cancel', confirmLabel],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const result = setup
    ? await dialog.showMessageBox(setup, options)
    : await dialog.showMessageBox(options);
  return result.response === 1;
}
async function helperAction(action: string) {
  if (!['capture', 'input', 'lock-off', 'lock-restore'].includes(action))
    throw new Error('Unknown permission action');
  if (action.startsWith('lock-')) {
    const off = action === 'lock-off';
    if (
      !(await confirm(
        off ? 'Turn off automatic screen lock?' : 'Restore automatic screen lock?',
        off
          ? 'Anyone with physical access to this computer can use its desktop without a password. Captures work unattended. Restore the lock from setup at any time.'
          : 'Restore the settings saved before Deploy turned off the lock. Captures show nothing while the screen is locked.',
        off ? 'Keep unlocked' : 'Restore lock',
      ))
    )
      return;
    await runDesktopHelper('screen-lock', { action: off ? 'off' : 'restore' });
  } else {
    const result = JSON.parse(
      await runDesktopHelper('install', {
        allowInput: action === 'input' || (await status()).node.capabilities.input.state === 'ok',
        json: true,
        source: readBundledHelper(join(directory, 'desktop-helper.py')),
      }),
    );
    if (!result.available)
      throw new Error(
        'The desktop helper is unavailable. Run deploy desktop-helper status for the dependency or session fix.',
      );
    if (result.sessionType === 'wayland') await desktopRequest('inspect', result.socketPath);
  }
  await refresh();
}
async function action(value: TrayAction) {
  try {
    if (value === 'quit') {
      quitting = true;
      app.quit();
    } else if (value === 'open') await safeExternal(coordinator());
    else if (value === 'pause') {
      setControlPaused(!controlPaused());
      await refresh();
    } else if (value === 'start' || value === 'stop' || value === 'restart') {
      if (
        value !== 'start' &&
        !(await confirm(
          `${value === 'stop' ? 'Stop' : 'Restart'} deploy.local server?`,
          'Connected tasks and the web app will be interrupted. The server remains a system service that starts at boot.',
          value === 'stop' ? 'Stop server' : 'Restart server',
        ))
      )
        return;
      await controlServer(value);
    } else if (value === 'logs')
      await dialog.showMessageBox({
        message: 'deploy-server.service logs',
        detail: redactLogs(await readJournal(), [
          readAgentConfig(configPath)?.secret,
          readAgentConfig(configPath)?.workerToken,
        ]),
        buttons: ['Close'],
      });
    else await openSetup(value === 'setup' ? '' : value);
  } catch (error) {
    dialog.showErrorBox(
      'deploy.local Node',
      error instanceof Error ? error.message : 'Action failed',
    );
  }
}
function menu(items: TrayItem[]): MenuItemConstructorOptions[] {
  return items.map(({ action: itemAction, submenu, ...item }) => ({
    ...item,
    ...(submenu ? { submenu: menu(submenu) } : {}),
    ...(itemAction ? { click: () => void action(itemAction) } : {}),
  }));
}
async function refresh() {
  if (refreshing || quitting) return;
  refreshing = true;
  try {
    const current = await status();
    const model = trayModel(current.node, monitor?.state || { present: false, connected: false });
    if (tray) {
      tray.setImage(icon(model.color));
      tray.setToolTip(model.items[0].label || 'deploy.local Node');
      tray.setContextMenu(Menu.buildFromTemplate(menu(model.items)));
    }
  } finally {
    refreshing = false;
  }
}
function registerBridge() {
  const handle = (name: string, callback: (...args: any[]) => unknown) =>
    ipcMain.handle(`node:${name}`, async (event, ...args) => {
      if (
        !setup ||
        event.sender !== setup.webContents ||
        event.senderFrame !== setup.webContents.mainFrame ||
        !allowed(event.senderFrame.url)
      )
        throw new Error('Setup window required');
      // Return bounded, non-sensitive failures to either renderer.
      try {
        return await callback(...args);
      } catch {
        throw new Error(
          'Action failed. Check the enrollment code, network, or local helper status and retry.',
        );
      }
    });
  handle('status', status);
  handle('enroll', async (url: unknown, code: unknown) => {
    if (
      setup?.webContents.getURL() !== localUrl ||
      typeof url !== 'string' ||
      typeof code !== 'string' ||
      code.length > 256 ||
      url.length > 2048
    )
      throw new Error('Local enrollment required');
    if (readAgentConfig(configPath)) throw new Error('This app is already enrolled');
    await joinAgent({
      coordinatorUrl: url,
      code,
      taskWorker: true,
      configPath,
      request: net.fetch,
    });
    setAutostart(true, launcher());
    startWorker();
    await openSetup('', true);
  });
  handle('helper', async (value: unknown) => {
    if (typeof value !== 'string') throw new Error('Invalid action');
    await helperAction(value);
  });
  handle('autostart', (enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid setting');
    setAutostart(enabled, launcher());
  });
  handle('permissions', () => openSetup('', true));
}
if (process.platform !== 'linux') {
  console.error('deploy.local Node supports Linux only. On macOS, use Deploy.app.');
  app.exit(1);
} else if (!app.requestSingleInstanceLock()) app.quit();
else {
  // Prefer native Wayland (XWayland needs an X authority the user service may not have).
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.on('second-instance', (_event, args) => {
    if (args.includes('--setup')) void app.whenReady().then(() => openSetup());
  });
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    quitting = true;
    clearInterval(refreshTimer);
    monitor?.close();
    worker?.kill('SIGTERM');
  });
  // In an ES module main, a top-level `await app.whenReady()` never resolves: Electron
  // fires 'ready' only after the entry module finishes evaluating. Start from a callback.
  app
    .whenReady()
    .then(start)
    .catch((failure) => {
      console.error('deploy.local Node could not start:', failure);
      app.exit(1);
    });
}
async function start() {
  app.setAppUserModelId('local.deploy.Node');
  const replacedLegacyTray = await removeLegacyTray().catch(() => {
    console.error(
      'Could not remove deploy-menubar.service. Run systemctl --user disable --now deploy-menubar.service.',
    );
    return false;
  });
  // The old tray started at every login; keep that for machines it ran on, such as a
  // coordinator that never enrolls as a node. Setup can still switch it off.
  if (replacedLegacyTray) setAutostart(true, launcher());
  if (process.env.DEPLOY_NODE_ENABLE_AUTOSTART === '1' && readAgentConfig(configPath)?.workerId)
    setAutostart(true, launcher());
  registerBridge();
  monitor = new SupervisorMonitor(await supervisorSocket(), () => {
    void refresh();
  });
  try {
    tray = new Tray(icon('red'));
    tray.on('double-click', () => void openSetup());
  } catch {
    /* headless service continues */
  }
  let trayHost = false;
  try {
    trayHost = (
      await exec('gdbus', [
        'call',
        '--session',
        '--dest',
        'org.freedesktop.DBus',
        '--object-path',
        '/org/freedesktop/DBus',
        '--method',
        'org.freedesktop.DBus.NameHasOwner',
        'org.kde.StatusNotifierWatcher',
      ])
    ).stdout.includes('true');
  } catch {
    /* no session bus or tray host */
  }
  if (!tray || !trayHost)
    console.log(
      'No tray host available. Enable the GNOME AppIndicator extension or open setup with deploy-node --setup.',
    );
  startWorker();
  await refresh();
  refreshTimer = setInterval(() => void refresh(), 3000);
  if (process.argv.includes('--setup')) await openSetup();
}
