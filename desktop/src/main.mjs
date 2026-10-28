import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  Notification,
  ipcMain,
  session,
  shell,
  dialog,
  screen,
} from 'electron';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hostname, cpus, totalmem, platform, release } from 'node:os';
import { randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import { CoordinatorClient, coordinatorOrigin, inspectCertificate, validPin } from './client.mjs';
import { InboxModel, trayModel, externalUrl } from './model.mjs';
import { Vault } from './vault.mjs';
import { WorkerManager } from './worker.mjs';
import { activeControl, controlBody } from './control.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shellFile = join(root, 'assets/shell.html');
const shellUrl = pathToFileURL(shellFile).href;
if (process.env.DEPLOY_DESKTOP_DATA_DIR)
  app.setPath('userData', process.env.DEPLOY_DESKTOP_DATA_DIR);
let quitting = false,
  window,
  trayWindow,
  tray,
  webWindow,
  watchWindow,
  client,
  worker,
  vault,
  saved = {},
  polling = false,
  generation = 0;
let inbox = new InboxModel();
const notifications = new Map();
const controlTasks = new Set();
const controlClientId = randomUUID();
let controlSession,
  checkingControl = false;
const state = {
  page: 'connect',
  origin: 'https://deploy.local',
  name: hostname(),
  platform: platform(),
  hardware: `${cpus()[0]?.model || platform()} · ${Math.round(totalmem() / 1024 ** 3)} GB · ${platform()} ${release()}`,
  online: false,
  roles: { takeTasks: true },
};
function publicState(page = state.page) {
  return {
    ...state,
    page,
    inbox: inbox.waiting(),
    workerId: saved.enrollment?.workerId,
    worker: worker?.status(),
    screenSupported: worker?.status().screenSupported,
  };
}
function update() {
  if (window && !window.isDestroyed()) window.webContents.send('shell:state', publicState());
  if (trayWindow && !trayWindow.isDestroyed())
    trayWindow.webContents.send('shell:state', publicState('tray'));
  if (!tray) return;
  const model = trayModel(publicState());
  tray.setTitle(model.count ? String(model.count) : '');
  tray.setToolTip(
    `deploy.local · ${model.connection} · Live ${model.live} · ${model.count} waiting on you`,
  );
  app.dock?.setBadge(model.count ? String(model.count) : '');
  tray.setImage(
    nativeImage
      .createFromPath(join(root, 'assets', `tray-${model.icon}.png`))
      .resize({ width: 20, height: 20 }),
  );
}
function localWindow(options = {}) {
  const win = new BrowserWindow({
    width: 720,
    height: 800,
    title: 'deploy.local',
    backgroundColor: '#f9f9fb',
    ...options,
    webPreferences: {
      preload: join(root, 'build/shell-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  void win.loadFile(shellFile);
  return win;
}
function show(page, error) {
  state.page = page;
  state.error = error || '';
  if (!window || window.isDestroyed()) {
    window = localWindow();
    window.on('close', (event) => {
      if (!quitting) {
        event.preventDefault();
        window.hide();
      }
    });
  }
  window.show();
  update();
}
function trustedSender(event, local = false) {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame)
    throw new Error('Only the main frame may use desktop controls.');
  if (local) {
    if (
      ![window, trayWindow, watchWindow].some((win) => win?.webContents === event.sender) ||
      event.senderFrame.url !== shellUrl
    )
      throw new Error('Untrusted shell.');
  } else if (
    event.sender !== webWindow?.webContents ||
    !client ||
    new URL(event.senderFrame.url).origin !== client.origin
  )
    throw new Error('Untrusted page.');
}
function configureSession() {
  const ses = session.fromPartition('persist:coordinator');
  ses.setCertificateVerifyProc((request, callback) => {
    if (client && request.hostname === new URL(client.origin).hostname && client.pin) {
      try {
        return callback(validPin(request.certificate.data, client.pin) ? 0 : -2);
      } catch {
        return callback(-2);
      }
    }
    callback(-3);
  });
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    for (const key of Object.keys(headers))
      if (['x-deploy-username', 'x-deploy-token'].includes(key.toLowerCase())) delete headers[key];
    if (client?.credentials && new URL(details.url).origin === client.origin) {
      headers['X-Deploy-Username'] = client.credentials.username;
      headers['X-Deploy-Token'] = client.credentials.token;
    }
    callback({ requestHeaders: headers });
  });
  return ses;
}
async function dashboard(path = '/dashboard') {
  if (!client?.credentials) return show('connect');
  if (!state.online) return show('offline');
  if (!webWindow || webWindow.isDestroyed()) {
    webWindow = new BrowserWindow({
      width: 1200,
      height: 820,
      title: 'deploy.local',
      webPreferences: {
        session: configureSession(),
        preload: join(root, 'src/preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    webWindow.on('close', (event) => {
      if (!quitting) {
        event.preventDefault();
        webWindow.hide();
      }
    });
    webWindow.webContents.setWindowOpenHandler(({ url }) => {
      void confirmExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    webWindow.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== client.origin) {
        event.preventDefault();
        void confirmExternal(url).catch(() => {});
      }
    });
    webWindow.webContents.on('will-redirect', (event, url) => {
      if (new URL(url).origin !== client.origin) event.preventDefault();
    });
    webWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
    webWindow.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (mainFrame && code !== -3) show('offline');
    });
  }
  window?.hide();
  trayWindow?.hide();
  webWindow.show();
  try {
    await webWindow.loadURL(client.origin + path);
  } catch {
    show('offline');
  }
}
async function confirmExternal(value) {
  const url = externalUrl(value);
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: 'Open in your browser?',
    detail: url,
    buttons: ['Cancel', 'Open'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response === 1) await shell.openExternal(url);
}
function save() {
  saved = {
    ...saved,
    origin: client.origin,
    pin: client.pin,
    credentials: client.credentials,
    roles: worker.selection,
  };
  vault.write(saved);
}
function review(id) {
  const item = inbox.items.get(id);
  if (!item || item.state !== 'waiting') throw new Error('This decision is no longer waiting.');
  if (item.kind === 'control' && item.taskId) controlTasks.add(item.taskId);
  state.item = item;
  trayWindow?.hide();
  show('decision');
}
function notify(id) {
  const item = inbox.items.get(id);
  if (!item || item.state !== 'waiting' || !Notification.isSupported() || notifications.has(id))
    return;
  const actions =
    process.platform === 'darwin'
      ? [
          { type: 'button', text: 'Review' },
          ...item.actions
            .filter((a) => ['dismiss', 'not-now', 'deny'].includes(a.id))
            .slice(0, 1)
            .map((a) => ({ type: 'button', text: a.label })),
        ]
      : [];
  const notification = new Notification({
    title: item.title,
    subtitle: `deploy.local · ${item.from}`,
    body: item.text,
    actions,
  });
  const reviewCurrent = () => {
    if (inbox.items.get(id)?.state === 'waiting') review(id);
    else void dashboard('/dashboard/inbox');
  };
  notification.on('click', reviewCurrent);
  notification.on('action', (_event, index) => {
    if (index === 0) reviewCurrent();
    else {
      const action = item.actions.find((a) => ['dismiss', 'not-now', 'deny'].includes(a.id));
      if (action) void answer(id, action.id).catch((error) => show('decision', error.message));
    }
  });
  notifications.set(id, notification);
  notification.show();
}
async function answer(id, actionId, note) {
  const item = inbox.items.get(id),
    action = item?.actions.find((a) => a.id === actionId);
  if (!action || item.state !== 'waiting' || !state.online)
    throw new Error('Refresh this decision before answering.');
  if (action.confirm || item.kind === 'control') {
    const result = await dialog.showMessageBox({
      message: action.label,
      detail: action.confirm || item.text,
      buttons: ['Cancel', action.label],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response !== 1) return;
  }
  try {
    const result = await client.answer(id, actionId, note);
    inbox.items.set(id, result.item);
  } catch (error) {
    if (error.status === 409 && error.data?.item) inbox.items.set(id, error.data.item);
    throw error;
  } finally {
    notifications.get(id)?.close();
    update();
  }
}
async function refresh() {
  const current = client,
    version = generation;
  if (!current?.credentials) return;
  try {
    const [items, live, computers] = await Promise.all([
      current.inbox(),
      current.live(),
      current.computers(),
    ]);
    if (version !== generation) return;
    const fresh = inbox.replace(items.items);
    state.live = live;
    state.summary = live?.summary;
    state.computers = computers;
    state.coordinatorName = computers?.find((entry) => entry.roles.includes('coordinator'))?.name;
    state.online = true;
    state.lastSeen = Date.now();
    fresh.forEach((item) => {
      if (item.kind === 'control' && item.taskId) controlTasks.add(item.taskId);
      notify(item.id);
    });
    update();
    if (state.page === 'offline') await dashboard();
  } catch (error) {
    if (version !== generation) return;
    state.online = false;
    if (error.status === 401) {
      client.credentials = null;
      saved.credentials = null;
      vault.write(saved);
      await worker.stop();
      show('signin', 'Your session expired. Sign in again.');
    } else if (['offline', 'dashboard'].includes(state.page) || webWindow?.isVisible()) {
      webWindow?.hide();
      show('offline');
    }
    update();
    throw error;
  }
}
async function poll() {
  if (polling || !client?.credentials || quitting) return;
  polling = true;
  try {
    if (!state.online) await refresh();
    const current = client,
      version = generation;
    const page = await current.events(inbox.cursor);
    if (version !== generation) return;
    inbox.apply(page).forEach((item) => {
      if (item.kind === 'control' && item.taskId) controlTasks.add(item.taskId);
      notify(item.id);
    });
    for (const [id, notification] of notifications)
      if (inbox.items.get(id)?.state !== 'waiting') notification.close();
    await refresh();
  } catch (error) {
    state.online = false;
    if (error.status === 401) {
      client.credentials = null;
      saved.credentials = null;
      vault.write(saved);
      await worker.stop();
      webWindow?.hide();
      show('signin', 'Your session expired. Sign in again.');
    } else if (state.page === 'dashboard' || webWindow?.isVisible()) {
      webWindow?.hide();
      show('offline');
    }
    update();
  } finally {
    polling = false;
    if (!quitting && client?.credentials) setTimeout(poll, state.online ? 100 : 10000);
  }
}
async function setRoles(value) {
  if (!client?.credentials) throw new Error('Sign in first.');
  if (!vault.available()) throw new Error('Unlock your system keychain before joining.');
  saved.enrollment = await worker.configure(value, client, saved.enrollment);
  try {
    save();
  } catch (error) {
    await worker.stop();
    throw error;
  }
  state.roles = worker.selection;
  update();
  return worker.status();
}
async function switchCoordinator() {
  generation++;
  await worker.stop();
  webWindow?.destroy();
  webWindow = undefined;
  await session.fromPartition('persist:coordinator').clearStorageData();
  client = null;
  saved = {};
  inbox = new InboxModel();
  state.online = false;
  state.lastSeen = null;
  state.summary = null;
  state.live = null;
  state.computers = null;
  vault.write({});
  show('connect');
}
ipcMain.on('shell:ready', (event) => {
  trustedSender(event, true);
  event.sender.send(
    'shell:state',
    publicState(
      event.sender === trayWindow?.webContents
        ? 'tray'
        : event.sender === watchWindow?.webContents
          ? 'watch'
          : state.page,
    ),
  );
});
ipcMain.handle('shell:action', async (event, body) => {
  trustedSender(event, true);
  try {
    state.error = '';
    if (body.action === 'connect') {
      state.origin = coordinatorOrigin(body.address);
      state.certificate = await inspectCertificate(state.origin);
      show(state.certificate ? 'trust' : 'signin');
      if (!state.certificate) client = new CoordinatorClient(state.origin);
    } else if (body.action === 'trust') {
      if (state.page !== 'trust' || body.confirmed !== 'on' || !state.certificate)
        throw new Error('Compare and confirm the fingerprint first.');
      client = new CoordinatorClient(state.origin, { pin: state.certificate.fingerprint });
      show('signin');
    } else if (body.action === 'signin') {
      if (!client || !vault.available())
        throw new Error('Unlock your system keychain to sign in securely.');
      await client.login(body.username, body.password);
      save();
      await refresh();
      show('setup');
      void poll();
    } else if (body.action === 'join') {
      await setRoles(
        Object.fromEntries(
          ['takeTasks', 'runApps', 'serveModels', 'useScreen'].map((key) => [
            key,
            body[key] === 'on',
          ]),
        ),
      );
      if (worker.selection.useScreen) show('permissions');
      else {
        state.page = 'dashboard';
        await dashboard();
      }
    } else if (['skip', 'finish', 'home', 'new-task'].includes(body.action)) {
      state.page = 'dashboard';
      await dashboard();
    } else if (body.action === 'back') show('connect');
    else if (body.action === 'roles') show('setup');
    else if (body.action === 'take-tasks') {
      if (!state.online) throw new Error('Reconnect before changing Take new tasks.');
      const { computer } = await client.takeNewTasks(
        saved.enrollment?.workerId,
        body.takeTasks === 'on',
      );
      state.computers = state.computers.map((entry) =>
        entry.id === computer.id ? computer : entry,
      );
    } else if (body.action === 'switch') await switchCoordinator();
    else if (body.action === 'retry') {
      await refresh();
      if (state.online) await dashboard();
    } else if (body.action === 'live') {
      state.page = 'dashboard';
      await dashboard('/dashboard/live');
    } else if (body.action === 'live-app') {
      state.page = 'dashboard';
      await dashboard(`/dashboard/live/${encodeURIComponent(body.appId)}`);
    } else if (body.action === 'review') review(body.itemId);
    else if (body.action?.startsWith('answer:')) {
      await answer(body.itemId, body.action.slice(7), body.note);
      if (inbox.items.get(body.itemId)?.state !== 'waiting') await dashboard();
    } else if (['pause-control', 'stop-control'].includes(body.action))
      await changeControl(body.action);
    else if (body.action === 'quit') app.quit();
    else if (body.action === 'screen-settings' && process.platform === 'darwin')
      await shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      );
    else if (body.action === 'accessibility-settings' && process.platform === 'darwin')
      await shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      );
    update();
  } catch (error) {
    state.error = error.message;
    update();
  }
});
ipcMain.on('desktop:session-marker', (event) => {
  try {
    trustedSender(event);
    event.returnValue = { username: client.credentials.username, token: 'desktop-session' };
  } catch {
    event.returnValue = null;
  }
});
const handlers = {
  'desktop:notify': (id) => notify(String(id)),
  'desktop:badge': (count) => {
    if (!Number.isInteger(count) || count !== inbox.waiting().length)
      throw new Error('Badge must match Waiting on you.');
    update();
  },
  'desktop:worker-status': () => worker.status(),
  'desktop:worker-roles': async (value) => {
    const result = await dialog.showMessageBox({
      message: 'Change this computer’s roles?',
      detail: 'Review the roles in desktop setup.',
      buttons: ['Cancel', 'Review'],
      cancelId: 0,
    });
    if (result.response === 1) {
      state.roles = value;
      show('setup');
    }
    return worker.status();
  },
  'desktop:control': (id) => {
    if (!worker.status().screenSupported)
      throw new Error('Use the screen is not supported in this build.');
    const item = inbox.items.get(id);
    if (item?.kind !== 'control') throw new Error('A Waiting on you screen request is required.');
    review(id);
  },
  'desktop:external': confirmExternal,
};
for (const [channel, handler] of Object.entries(handlers))
  ipcMain.handle(channel, (event, ...args) => {
    trustedSender(event);
    return handler(...args);
  });
async function checkControl() {
  if (checkingControl || !client || !saved.enrollment || !worker.selection.useScreen) return;
  checkingControl = true;
  try {
    let active;
    for (const taskId of controlTasks) {
      const result = await client.request(
        `/api/workspace/tasks/${encodeURIComponent(taskId)}/controls`,
      );
      const match = activeControl(result.sessions, saved.enrollment.workerId);
      if (match) {
        active = { ...match, taskId };
        break;
      }
    }
    controlSession = active;
    if (!active) {
      watchWindow?.hide();
      return;
    }
    const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(active.createdAt)) / 1000));
    state.control = {
      label: `${active.controlOwner === 'agent' ? 'Agent is using' : 'Paused ·'} ${active.targetLabel}`,
      elapsed: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
    };
    if (!watchWindow || watchWindow.isDestroyed()) {
      const area = screen.getPrimaryDisplay().workArea;
      watchWindow = localWindow({
        width: 540,
        height: 56,
        x: Math.round(area.x + (area.width - 540) / 2),
        y: area.y + 12,
        frame: false,
        resizable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
      });
      watchWindow.setAlwaysOnTop(true, 'screen-saver');
      watchWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      watchWindow.on('close', (event) => {
        if (!quitting && controlSession) event.preventDefault();
      });
    }
    watchWindow.showInactive();
    watchWindow.webContents.send('shell:state', publicState('watch'));
  } catch {
    watchWindow?.hide();
  } finally {
    checkingControl = false;
  }
}
async function changeControl(action) {
  if (!controlSession) return;
  const current = controlSession;
  await client.request(
    `/api/workspace/tasks/${encodeURIComponent(current.taskId)}/controls/${action === 'stop-control' ? 'stop' : 'takeover'}`,
    {
      method: 'POST',
      body: { ...controlBody(current, controlClientId), operationId: randomUUID() },
    },
  );
  await checkControl();
}
await app.whenReady();
setInterval(() => void checkControl(), 1000).unref();
vault = new Vault(join(app.getPath('userData'), 'session.enc'), safeStorage);
saved = vault.read() || {};
const resources = app.isPackaged ? process.resourcesPath : join(root, 'build');
const helperPath = join(resources, 'helpers/deploy-control-helper');
worker = new WorkerManager({
  root: join(app.getPath('userData'), 'workers'),
  executable: process.execPath,
  entry: join(resources, 'worker/worker.mjs'),
  helper: process.platform === 'darwin' && existsSync(helperPath) ? helperPath : undefined,
  onChange: update,
  onControls: (taskIds) => {
    for (const id of taskIds) controlTasks.add(id);
  },
});
tray = new Tray(nativeImage.createEmpty());
function showTray() {
  if (!trayWindow || trayWindow.isDestroyed()) {
    trayWindow = localWindow({
      width: 340,
      height: 650,
      frame: false,
      resizable: false,
      skipTaskbar: true,
    });
    trayWindow.on('blur', () => trayWindow.hide());
  }
  const bounds = tray.getBounds(),
    area = screen.getDisplayMatching(bounds).workArea;
  trayWindow.setPosition(
    Math.max(area.x, Math.min(bounds.x, area.x + area.width - 340)),
    bounds.y < area.y + area.height / 2 ? area.y : area.y + area.height - 650,
  );
  trayWindow.show();
  update();
}
tray.on('click', showTray);
tray.on('right-click', () =>
  tray.popUpContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open deploy.local', click: () => void dashboard() },
      { label: 'Computer roles', click: () => show('setup') },
      { label: 'Use another coordinator', click: () => void switchCoordinator() },
      { type: 'separator' },
      { label: 'Quit — stops the worker', click: () => app.quit() },
    ]),
  ),
);
Menu.setApplicationMenu(
  Menu.buildFromTemplate([
    {
      label: 'deploy.local',
      submenu: [
        { label: 'New task', accelerator: 'CmdOrCtrl+N', click: () => void dashboard() },
        { label: 'Open deploy.local', accelerator: 'CmdOrCtrl+O', click: () => void dashboard() },
        { label: 'Computer roles', click: () => show(client ? 'setup' : 'connect') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]),
);
app.on('activate', () => void dashboard());
app.on('window-all-closed', () => {});
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  generation++;
  void worker.stop().finally(() => app.quit());
});
if (saved.origin && saved.credentials) {
  client = new CoordinatorClient(saved.origin, saved);
  state.origin = client.origin;
  state.roles = saved.roles;
  state.page = 'dashboard';
  try {
    await refresh();
    if (saved.roles) await setRoles(saved.roles);
    await dashboard();
  } catch {
    show('offline');
  }
  void poll();
} else show('connect');
update();
