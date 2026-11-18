import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  ipcMain,
  session,
  shell,
  dialog,
  screen,
} from 'electron';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hostname, cpus, totalmem, platform, release } from 'node:os';
import { randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import {
  CoordinatorClient,
  certificateProblem,
  coordinatorOrigin,
  inspectCertificate,
} from './client.mjs';
import { InboxModel, trayModel, externalUrl, roles } from './model.mjs';
import { icon } from './icons.mjs';
import { Vault } from './vault.mjs';
import { WorkerManager } from './worker.mjs';
import { DesktopUpdater } from './updater.mjs';
import { prepareInstall, readHandoff, acknowledgeStart, returnPage } from './update-install.mjs';
import { activeControl, controlBody } from './control.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shellFile = join(root, 'assets/shell.html');
const shellUrl = pathToFileURL(shellFile).href;
const dataArgument = process.argv
  .find((arg) => arg.startsWith('--deploy-data-dir='))
  ?.slice('--deploy-data-dir='.length);
if (dataArgument || process.env.DEPLOY_DESKTOP_DATA_DIR)
  app.setPath('userData', dataArgument || process.env.DEPLOY_DESKTOP_DATA_DIR);
let buildInfo = null;
try {
  buildInfo = JSON.parse(readFileSync(join(root, 'build/build-info.json'), 'utf8'));
} catch {}
let updater, handoff;
if (app.isPackaged && process.env.DEPLOY_DESKTOP_FIXTURE === '1')
  throw new Error('Fixture capture is only available in unpackaged Electron.');
const fixtureMode = !app.isPackaged && process.env.DEPLOY_DESKTOP_FIXTURE === '1';
// Loaded in start(): Electron never fires ready for an ES-module main process that awaits at
// the top level, so nothing before app.whenReady() may await.
let fixture = null;
if (fixtureMode) {
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
  app.commandLine.appendSwitch('disable-features', 'MediaRouter');
}
let quitting = false,
  window,
  trayWindow,
  tray,
  webWindow,
  watchWindow,
  client,
  worker,
  appWorker,
  vault,
  saved = {},
  polling = false,
  failures = 0,
  pendingPage = null,
  webFailed = false,
  retryUrl = '',
  lastRetry = 0,
  generation = 0;
let inbox = new InboxModel();
const notifications = new Map();
const controlTasks = new Set();
const controlClientId = randomUUID();
let controlSession,
  checkingControl = false,
  checkingCertificate = false;
const state = {
  page: 'connect',
  origin: coordinatorOrigin(process.env.DEPLOY_COORDINATOR_URL || 'https://deploy.local'),
  name: hostname(),
  platform: platform(),
  arch: process.arch,
  hardware: `${cpus()[0]?.model || platform()} · ${Math.round(totalmem() / 1024 ** 3)} GB · ${platform()} ${release()}`,
  online: false,
  roles: { takeTasks: true },
};
function publicState(page = state.page) {
  return {
    ...state,
    page,
    name: state.appWorker?.name || state.name,
    inbox: inbox.waiting(),
    workerId: saved.enrollment?.workerId,
    worker: worker?.status(),
    screenSupported: worker?.status().screenSupported,
  };
}
function update() {
  if (window && !window.isDestroyed()) window.webContents.send('shell:state', publicState());
  connection();
  if (trayWindow && !trayWindow.isDestroyed())
    trayWindow.webContents.send('shell:state', publicState('tray'));
  if (!tray) return;
  const model = trayModel(publicState());
  if (process.platform === 'darwin') tray.setTitle(model.count ? String(model.count) : '');
  tray.setToolTip(
    `deploy.local · ${model.connection} · Live ${model.live} · ${model.count} waiting on you`,
  );
  app.dock?.setBadge(model.count ? String(model.count) : '');
  tray.setImage(
    nativeImage
      .createFromBuffer(
        icon(40, {
          failing: model.icon === 'failing',
          warning: model.icon === 'warning',
          offline: model.icon === 'offline',
          count: process.platform === 'darwin' ? 0 : model.count,
          dark: nativeTheme.shouldUseDarkColors,
        }),
      )
      .resize({ height: 20 }),
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
// Connection changes are noticed in the background. They switch pages only while deploy.local is
// the app in use; otherwise the page waits for the next focus or Dock click, so a coordinator
// restart never pulls the app in front of another one.
function backgroundPage(page, error) {
  if (BrowserWindow.getFocusedWindow()) return openPage(page, error);
  pendingPage = { page, error };
  state.page = page;
  state.error = error || '';
  update();
}
// Losing the coordinator never takes the main window away. The page you are on stays with a notice
// over it, and a page that could not load shows the notice in its place until the coordinator answers.
// Tells the page it is in the Mac app without a title bar, so it leaves room for the traffic
// lights and marks its drag regions; full screen hides the lights, so the room goes too.
function chrome() {
  if (!webWindow || webWindow.isDestroyed()) return;
  webWindow.webContents.send('desktop:chrome', {
    mac: process.platform === 'darwin',
    fullScreen: webWindow.isFullScreen(),
  });
}
function connection() {
  if (!webWindow || webWindow.isDestroyed()) return;
  webWindow.webContents.send('desktop:connection', {
    // The offline page says it itself; the notice is for a page that is still showing.
    online: state.online || webFailed,
    name: state.coordinatorName || 'your coordinator',
  });
}
function offlinePage() {
  webFailed = true;
  void webWindow.loadFile(join(root, 'assets/offline.html'), {
    query: {
      name: state.coordinatorName || 'your coordinator',
      host: client ? new URL(client.origin).hostname : '',
    },
  });
}
async function reconnected() {
  // Refresh runs constantly while online, so a page that keeps failing is retried every 10 s.
  if (!webFailed || !webWindow || webWindow.isDestroyed() || Date.now() - lastRetry < 10000) return;
  lastRetry = Date.now();
  try {
    await webWindow.loadURL(retryUrl || client.origin + '/dashboard');
  } catch {
    // did-fail-load shows the offline page again; the next refresh retries.
  }
}
function openPage(page, error) {
  pendingPage = null;
  if (page === 'dashboard') return dashboard();
  webWindow?.hide();
  show(page, error);
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
    if (client && request.hostname === new URL(client.origin).hostname && client.trusted) {
      try {
        const trust = { ca: client.ca, pin: client.pin };
        return callback(
          certificateProblem(request.certificate.data, trust, request.hostname) ? -2 : 0,
        );
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
// Showing deploy.local again (Dock, tray, focus, reconnect) keeps the page you were on. Only a link
// to a place, or a page that never loaded, navigates the window.
async function dashboard(path) {
  if (!client?.credentials) return show('connect');
  // Nothing loads from the coordinator until you have compared its new certificate.
  if (state.certificate?.previous) return show('certificate-changed');
  if (!webWindow || webWindow.isDestroyed()) {
    webWindow = new BrowserWindow({
      width: 1200,
      height: 820,
      title: 'deploy.local',
      // No title bar on a Mac: the traffic lights sit in the sidebar's top row, which the page
      // makes a drag region (see chrome()).
      ...(process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 20 } }
        : {}),
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
    webWindow.webContents.on('did-fail-load', (_event, code, _description, url, mainFrame) => {
      if (!mainFrame || code === -3) return;
      if (client && url.startsWith(client.origin + '/')) retryUrl = url;
      offlinePage();
    });
    webWindow.webContents.on('did-finish-load', () => {
      if (new URL(webWindow.webContents.getURL()).origin === client.origin) webFailed = false;
    });
    webWindow.webContents.on('dom-ready', connection);
    webWindow.webContents.on('dom-ready', chrome);
    webWindow.on('enter-full-screen', chrome);
    webWindow.on('leave-full-screen', chrome);
  }
  state.page = 'dashboard';
  window?.hide();
  trayWindow?.hide();
  webWindow.show();
  const current = webWindow.webContents.getURL();
  if (path) retryUrl = client.origin + path;
  if (!state.online) return offlinePage();
  if (!path && !webFailed && current && new URL(current).origin === client.origin) return;
  try {
    await webWindow.loadURL(path || !retryUrl ? client.origin + (path || '/dashboard') : retryUrl);
  } catch {
    // did-fail-load shows the offline page in this window.
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
function save(selection = { ...worker.selection, runApps: saved.roles?.runApps ?? false }) {
  saved = {
    ...saved,
    origin: client.origin,
    ca: client.ca,
    pin: client.pin,
    credentials: client.credentials,
    roles: selection,
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
  if (!item || item.state !== 'waiting' || notifications.has(id)) return;
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
  const options = {
    title: item.title,
    subtitle: `deploy.local · ${item.from}`,
    body: item.text,
    actions,
  };
  if (fixture) writeFileSync(fixture.notificationFile, JSON.stringify(options, null, 2));
  if (!Notification.isSupported()) return;
  const notification = new Notification(options);
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
    const [items, live, computers, workspace] = await Promise.all([
      current.inboxSnapshot(inbox.cursor),
      current.live(),
      current.computers(),
      current.workspace().catch(() => null),
    ]);
    if (version !== generation) return;
    inbox.cursor ??= items.cursor;
    const fresh = inbox.replace(items.items);
    state.live = live;
    state.summary = live?.summary;
    state.computers = computers;
    state.coordinatorName =
      computers?.find(
        (entry) => entry.roles?.includes('coordinator') || entry.kind === 'coordinator',
      )?.name || state.coordinatorName;
    const localWorkers =
      computers?.find((entry) => entry.workerIds?.includes(saved.enrollment?.workerId))
        ?.workerIds || [];
    if (workspace)
      state.runningTask = workspace.tasks?.find((task) => {
        const run = workspace.runs?.findLast((entry) => entry.taskId === task.id);
        return (
          (run?.status === 'running' || task.status === 'running') &&
          localWorkers.includes(run?.workerId || task.workerId)
        );
      });
    saved.coordinatorName = state.coordinatorName;
    saved.runningTask = state.runningTask;
    vault.write(saved);
    state.online = true;
    state.lastSeen = Date.now();
    if (client.pin && !client.ca) await adoptCa(current);
    fresh.forEach((item) => {
      if (item.kind === 'control' && item.taskId) controlTasks.add(item.taskId);
      notify(item.id);
    });
    update();
    await reconnected();
  } catch (error) {
    if (version !== generation) return;
    if (error.code === 'CERTIFICATE_CHANGED') await certificateChanged(current);
    if (error.status === 401) {
      state.online = false;
      client.credentials = null;
      saved.credentials = null;
      vault.write(saved);
      await worker.stop();
      backgroundPage('signin', 'Your session expired. Sign in again.');
    }
    update();
    throw error;
  }
}
// Macs set up before CA trust hold the exact certificate's fingerprint. While that certificate still
// answers, the CA that signs it is trusted in its place, so the next renewal needs nothing from you.
async function adoptCa(current) {
  try {
    const seen = await inspectCertificate(current.origin);
    if (current !== client || !seen || seen.certificate !== current.pin) return;
    current.ca = seen.ca;
    current.pin = undefined;
    save();
  } catch {
    // Tried again after the next successful refresh.
  }
}
// The coordinator answers with a certificate its trusted CA did not sign. Show what changed and wait
// for you to compare it; nothing is sent to the coordinator until then.
async function certificateChanged(current) {
  state.online = false;
  if (checkingCertificate || state.certificate?.previous) return;
  checkingCertificate = true;
  try {
    const seen = await inspectCertificate(current.origin);
    if (current !== client || !seen || seen.fingerprint === current.trusted) return;
    state.certificate = { ...seen, previous: current.trusted };
    backgroundPage('certificate-changed');
  } catch {
    // Not answering: the offline notice stays, and the next poll looks again.
  } finally {
    checkingCertificate = false;
  }
}
async function trustChanged() {
  const shown = state.certificate;
  if (state.page !== 'certificate-changed' || !shown?.previous || !client)
    throw new Error('Compare the new fingerprint first.');
  const seen = await inspectCertificate(client.origin);
  if (seen?.fingerprint !== shown.fingerprint) {
    state.certificate = seen && { ...seen, previous: shown.previous };
    throw new Error('The certificate changed again while you were comparing. Compare this one.');
  }
  client.ca = seen.ca;
  client.pin = undefined;
  state.certificate = null;
  save();
  // The window's session re-checks the coordinator against the new CA on fresh connections.
  const ses = configureSession();
  await ses.closeAllConnections();
  failures = 0;
  if (saved.roles && saved.enrollment)
    saved.enrollment = await worker.configure(saved.roles, client, saved.enrollment);
  state.page = 'dashboard';
  await refresh().catch(() => {});
  await dashboard();
}
async function poll() {
  if (polling || !client?.credentials || quitting) return;
  polling = true;
  try {
    if (!state.online || inbox.cursor === null) await refresh();
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
    failures = 0;
  } catch (error) {
    console.error('[desktop] Coordinator poll failed:', error.message);
    // One slow or dropped request is retried after a second. Only a second failure in a row
    // counts as the coordinator being unreachable, so a blip never shows the offline notice.
    failures++;
    if (error.status === 401 || failures >= 2) state.online = false;
    if (error.status === 401) {
      client.credentials = null;
      saved.credentials = null;
      vault.write(saved);
      await worker.stop();
      backgroundPage('signin', 'Your session expired. Sign in again.');
    }
    update();
  } finally {
    polling = false;
    if (!quitting && client?.credentials)
      setTimeout(poll, state.online ? (failures ? 1000 : 100) : 10000);
  }
}
async function refreshAppWorker(force = false) {
  if (!appWorker || !client?.credentials) return;
  const current = appWorker;
  try {
    const result = await current.status(force);
    if (appWorker === current) state.appWorker = result;
  } catch (error) {
    if (appWorker === current) state.error = error.message;
  }
  update();
}
async function connectAppWorker() {
  if (process.platform !== 'darwin' || fixture) return;
  const { AppWorker } = await import('../build/app-worker.mjs');
  appWorker = new AppWorker({
    client,
    onProgress: (message) => {
      state.workerProgress = message;
      update();
    },
  });
  await refreshAppWorker(true);
}
async function setup() {
  await refreshAppWorker();
  if (state.appWorker?.install === 'desktop')
    state.roles = { ...state.roles, runApps: state.appWorker.enabled };
  show(state.appWorker?.install === 'command-line' && !saved.workerDeclined ? 'takeover' : 'setup');
}
async function changeRunApps(enabled) {
  if (!appWorker) throw new Error('Run apps is not supported here yet.');
  const detected = await appWorker.detect();
  if (detected.install === 'command-line')
    throw new Error('Move the worker to this app before changing Run apps.');
  if (enabled && detected.install === 'none') await appWorker.install();
  else if (detected.install === 'desktop') await appWorker.setEnabled(enabled);
  state.roles = { ...state.roles, runApps: enabled };
  save({ ...worker.selection, runApps: enabled });
  await refreshAppWorker(true);
}
async function setRoles(value) {
  if (!client?.credentials) throw new Error('Sign in first.');
  if (!vault.available()) throw new Error('Unlock your system keychain before joining.');
  const selection = roles(value, process.platform, worker.status().screenSupported);
  if (
    selection.runApps !== !!state.appWorker?.enabled &&
    (selection.runApps || state.appWorker?.install === 'desktop')
  )
    await changeRunApps(selection.runApps);
  saved.enrollment = await worker.configure(selection, client, saved.enrollment);
  state.roles = worker.selection;
  try {
    save(worker.selection);
  } catch (error) {
    await worker.stop();
    throw error;
  }
  state.roles = worker.selection;
  update();
  return worker.status();
}
async function switchCoordinator() {
  await appWorker?.operation?.catch(() => {});
  generation++;
  await updater?.dispose();
  updater = null;
  await worker.stop();
  appWorker = null;
  state.appWorker = undefined;
  state.workerProgress = undefined;
  webWindow?.destroy();
  webWindow = undefined;
  await session.fromPartition('persist:coordinator').clearStorageData();
  client = null;
  saved = {};
  state.certificate = null;
  state.coordinatorName = undefined;
  state.runningTask = undefined;
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
    if (
      appWorker?.busy &&
      [
        'connect',
        'trust',
        'signin',
        'join',
        'take-over',
        'leave-worker',
        'run-apps',
        'setup-run-apps',
        'repair-worker',
        'restart-docker',
        'remove-leftover',
        'trust-changed',
      ].includes(body.action)
    )
      throw new Error('The worker is already being changed. Wait for it to finish.');
    if (body.action === 'connect') {
      if (fixture && body.address !== fixture.origin)
        throw new Error('Capture uses only its fixture coordinator.');
      state.origin = coordinatorOrigin(body.address);
      state.certificate = await inspectCertificate(state.origin);
      show(state.certificate ? 'trust' : 'signin');
      if (!state.certificate) client = new CoordinatorClient(state.origin);
    } else if (body.action === 'trust') {
      if (state.page !== 'trust' || body.confirmed !== 'on' || !state.certificate)
        throw new Error('Compare and confirm the fingerprint first.');
      client = new CoordinatorClient(state.origin, { ca: state.certificate.ca });
      show('signin');
    } else if (body.action === 'signin') {
      if (!client || !vault.available())
        throw new Error('Unlock your system keychain to sign in securely.');
      await client.login(body.username, body.password);
      saved.workerDeclined = false;
      save();
      await connectAppWorker();
      startUpdater();
      await refresh();
      await setup();
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
      await dashboard('/dashboard');
    } else if (body.action === 'back') show('connect');
    else if (body.action === 'roles') await setup();
    else if (body.action === 'leave-worker') {
      saved.workerDeclined = true;
      save();
      await dashboard();
    } else if (body.action === 'take-over') {
      if (!appWorker) throw new Error('Run apps is not supported here yet.');
      await appWorker.takeOver();
      state.roles = { ...state.roles, runApps: true };
      save({ ...worker.selection, runApps: true });
      await refreshAppWorker(true);
      await setup();
    } else if (body.action === 'run-apps' || body.action === 'setup-run-apps') {
      if (body.action === 'setup-run-apps')
        state.roles = {
          ...state.roles,
          ...Object.fromEntries(
            ['takeTasks', 'serveModels', 'useScreen'].map((key) => [key, body[key] === 'on']),
          ),
        };
      await changeRunApps(body.runApps === 'on');
    } else if (['repair-worker', 'restart-docker', 'remove-leftover'].includes(body.action)) {
      if (!appWorker) throw new Error('Run apps is not supported here yet.');
      if (
        body.action === 'repair-worker' &&
        (await appWorker.detect()).install === 'command-line'
      ) {
        await refreshAppWorker(true);
        show('takeover');
        return;
      }
      if (body.action === 'repair-worker') await appWorker.repair();
      else if (body.action === 'restart-docker') await appWorker.restartDocker();
      else await appWorker.removeLeftover(body.path);
      await refreshAppWorker(true);
    } else if (body.action === 'take-tasks') {
      if (!state.online) throw new Error('Reconnect before changing Take new tasks.');
      const { computer } = await client.takeNewTasks(
        saved.enrollment?.workerId,
        body.takeTasks === 'on',
      );
      state.computers = state.computers.map((entry) =>
        entry.id === computer.id ? computer : entry,
      );
    } else if (body.action === 'trust-changed') await trustChanged();
    else if (body.action === 'switch') await switchCoordinator();
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
    if (body.action === 'setup-run-apps') {
      await refreshAppWorker(true);
      if (state.appWorker?.install === 'command-line' && !saved.workerDeclined)
        state.page = 'takeover';
    }
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
  'desktop:update-status': () => updater?.status() ?? { phase: 'idle' },
  'desktop:update-start': () => updater?.start(),
  'desktop:update-cancel': () => updater?.cancel(),
  'desktop:update-restart': () => updater?.restart(webWindow.webContents.getURL()),
  'desktop:notify': (id) => notify(String(id)),
  'desktop:badge': (count) => {
    if (!Number.isInteger(count) || count !== inbox.waiting().length)
      throw new Error('Badge must match Waiting on you.');
    update();
  },
  'desktop:worker-status': async () => {
    await refreshAppWorker();
    return {
      ...worker.status(),
      roles: saved.roles || worker.selection,
      appWorker: state.appWorker,
    };
  },
  'desktop:worker-roles': async (value) => {
    const result = await dialog.showMessageBox({
      message: 'Change this computer’s roles?',
      detail: 'Review the roles in desktop setup.',
      buttons: ['Cancel', 'Review'],
      cancelId: 0,
    });
    if (result.response === 1) {
      state.roles = value;
      await setup();
    }
    return {
      ...worker.status(),
      roles: saved.roles || worker.selection,
      appWorker: state.appWorker,
    };
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
      const result = await client.request(`/api/tasks/${encodeURIComponent(taskId)}/controls`);
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
    `/api/tasks/${encodeURIComponent(current.taskId)}/controls/${action === 'stop-control' ? 'stop' : 'takeover'}`,
    {
      method: 'POST',
      body: { ...controlBody(current, controlClientId), operationId: randomUUID() },
    },
  );
  await checkControl();
}
function showTray() {
  if (!trayWindow || trayWindow.isDestroyed()) {
    trayWindow = localWindow({
      width: 340,
      height: 650,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: true,
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

function startUpdater() {
  if (process.platform !== 'darwin' || !app.isPackaged || !buildInfo || updater) return;
  updater = new DesktopUpdater({
    build: buildInfo,
    client: () => client,
    directory: join(app.getPath('userData'), 'updates'),
    onChange: (status) => {
      if (
        webWindow &&
        !webWindow.isDestroyed() &&
        webWindow.webContents.getURL().startsWith(client?.origin + '/')
      )
        webWindow.webContents.send('desktop:update', status);
    },
    install: async (staged, page, build) => {
      await prepareInstall({
        executable: app.getPath('exe'),
        staged,
        directory: app.getPath('userData'),
        page,
        build,
      });
      // Give the page time to paint the brief Installing state before the handoff.
      setTimeout(() => app.quit(), 500);
    },
  });
  void updater.check();
}
async function start() {
  if (process.platform === 'darwin' && app.isPackaged) {
    try {
      handoff = readHandoff({
        args: process.argv,
        directory: app.getPath('userData'),
        executable: app.getPath('exe'),
        build: buildInfo,
      });
    } catch (error) {
      console.error('[desktop update]', error);
      app.quit();
      return;
    }
  }
  setInterval(() => void updater?.check(), 4 * 60 * 60 * 1000).unref();
  fixture = fixtureMode ? (await import('../scripts/fixture-runtime.mjs')).fixtureRuntime() : null;
  if (fixture) {
    Object.assign(state, fixture.state);
    // Playwright's electron.evaluate cannot import modules, so captures reach this through a global.
    globalThis.deployCaptureFixture = captureFixture;
  }
  setInterval(() => void checkControl(), 1000).unref();
  vault = fixture?.vault || new Vault(join(app.getPath('userData'), 'session.enc'), safeStorage);
  saved = vault.read() || {};
  state.coordinatorName = saved.coordinatorName;
  state.runningTask = saved.runningTask;
  const resources = app.isPackaged ? process.resourcesPath : join(root, 'build');
  const helperPath = join(resources, 'helpers/deploy-control-helper');
  worker =
    fixture?.worker ||
    new WorkerManager({
      root: join(app.getPath('userData'), 'workers'),
      executable: process.execPath,
      entry: join(resources, 'worker/worker.mjs'),
      helper:
        process.platform === 'darwin' && process.arch !== 'x64' && existsSync(helperPath)
          ? helperPath
          : undefined,
      onChange: update,
      onControls: (taskIds) => {
        for (const id of taskIds) controlTasks.add(id);
      },
    });
  if (fixture) saved.enrollment = fixture.enrollment;
  tray = new Tray(nativeImage.createEmpty());
  nativeTheme.on('updated', update);
  tray.on('click', showTray);
  tray.on('right-click', () =>
    tray.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open deploy.local', click: () => void dashboard() },
        { label: 'Computer roles', click: () => void setup() },
        { label: 'Use another coordinator', click: () => void switchCoordinator() },
        { type: 'separator' },
        {
          label:
            state.appWorker?.install && state.appWorker.install !== 'none'
              ? 'Quit — apps keep running'
              : 'Quit — stops the worker',
          click: () => app.quit(),
        },
      ]),
    ),
  );
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'deploy.local',
        submenu: [
          {
            label: 'New task',
            accelerator: 'CmdOrCtrl+N',
            click: () => void dashboard('/dashboard'),
          },
          { label: 'Open deploy.local', accelerator: 'CmdOrCtrl+O', click: () => void dashboard() },
          { label: 'Computer roles', click: () => (client ? void setup() : show('connect')) },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
  app.on(
    'activate',
    () => void (pendingPage ? openPage(pendingPage.page, pendingPage.error) : dashboard()),
  );
  app.on('browser-window-focus', (_event, focused) => {
    if (pendingPage && (focused === webWindow || focused === window))
      void openPage(pendingPage.page, pendingPage.error);
  });
  app.on('window-all-closed', () => {});
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    generation++;
    void Promise.all([
      worker.stop(),
      updater?.dispose(),
      appWorker?.operation?.catch(() => {}),
    ]).finally(() => app.quit());
  });
  if (saved.origin && saved.credentials) {
    client = new CoordinatorClient(saved.origin, saved);
    startUpdater();
    state.origin = client.origin;
    state.roles = saved.roles;
    await connectAppWorker();
    state.page = 'dashboard';
    try {
      await refresh();
      if (saved.roles) {
        saved.enrollment = await worker.configure(saved.roles, client, saved.enrollment);
        save();
      }
    } catch {
      // Offline at launch: the main window opens with the offline notice and recovers on its own.
    }
    if (client.credentials) {
      // Open the restored page without tying startup acknowledgement to coordinator availability.
      if (state.appWorker?.install === 'command-line' && !saved.workerDeclined) await setup();
      else void dashboard(handoff ? returnPage(handoff.page, client.origin) : undefined);
    }
    void poll();
  } else show('connect');
  setInterval(() => void refreshAppWorker(), 15000).unref();
  update();
  if (!(await acknowledgeStart(handoff))) app.quit();
}
app.whenReady().then(start);

// Main-process-only capture controls. No renderer IPC or preload capability is added.
export async function captureFixture(page) {
  if (!fixture) throw new Error('Not a fixture session.');
  if (page === 'Tray') {
    showTray();
    return trayWindow.id;
  }
  if (page === 'Notification') {
    const id = inbox.waiting()[0]?.id;
    notifications.get(id)?.close();
    notifications.delete(id);
    notify(id);
    return fixture.notificationFile;
  }
  if (page === 'CertificateChanged') {
    const issued = new Date();
    issued.setHours(9, 11, 0, 0);
    const bytes = (start, end) => [...start, ...Array(20).fill('00'), ...end].join(':');
    state.online = false;
    state.certificate = {
      previous: bytes(['4F', 'A2', '19', 'C7', '0B', 'E3'], ['88', 'D1', '5E', '42', '9C', '07']),
      fingerprint: bytes(
        ['CA', '40', '8C', 'AF', 'D7', '6E'],
        ['2A', '88', 'F1', '9D', '13', '97'],
      ),
      address: '192.168.1.20',
      issued: issued.toISOString(),
      expires: '2029-02-20T17:11:53Z',
    };
    show('certificate-changed');
    return window.id;
  }
  if (!['Permissions', 'Offline'].includes(page)) throw new Error('Unknown capture page.');
  if (page === 'Offline') {
    state.online = false;
    fixture.worker.state = 'Disconnected';
    state.lastSeen = Date.parse('2026-10-27T18:41:00Z');
  }
  show(page.toLowerCase());
  return window.id;
}
