// The browser `deploy design check` draws boards with on this computer: Playwright's Chromium if it
// was installed (deploy browser install, or a project's own Playwright), else the computer's Chrome,
// Chromium or Edge. It is driven over the DevTools protocol with Node's own WebSocket, so the CLI
// needs no Playwright of its own: the standalone binary and a fresh worktree draw the same way.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Where Playwright keeps its browsers on this computer. */
export function playwrightCache(env = process.env, platform = process.platform, home = homedir()) {
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0')
    return env.PLAYWRIGHT_BROWSERS_PATH;
  if (platform === 'darwin') return join(home, 'Library/Caches/ms-playwright');
  if (platform === 'win32')
    return join(env.LOCALAPPDATA || join(home, 'AppData/Local'), 'ms-playwright');
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'ms-playwright');
}

/** Playwright's executables inside one of its browser folders, newest layout first. */
function playwrightExecutables(folder, platform) {
  const mac = [
    'chrome-headless-shell-mac-arm64/chrome-headless-shell',
    'chrome-headless-shell-mac-x64/chrome-headless-shell',
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-mac/headless_shell',
  ];
  const linux = [
    'chrome-headless-shell-linux64/chrome-headless-shell',
    'chrome-headless-shell-linux-arm64/chrome-headless-shell',
    'chrome-linux64/chrome',
    'chrome-linux/headless_shell',
    'chrome-linux/chrome',
  ];
  const windows = [
    'chrome-headless-shell-win64/chrome-headless-shell.exe',
    'chrome-win64/chrome.exe',
    'chrome-win/headless_shell.exe',
    'chrome-win/chrome.exe',
  ];
  const list = platform === 'darwin' ? mac : platform === 'win32' ? windows : linux;
  return list.map((path) => join(folder, path));
}

/**
 * The browsers this computer has, best first: DEPLOY_CHROMIUM, Playwright's headless shell and
 * Chromium (newest first), then the computer's own Chrome, Chromium or Edge.
 */
export function chromiumCandidates({
  env = process.env,
  platform = process.platform,
  home = homedir(),
  exists = existsSync,
  list = (folder) => readdirSync(folder),
} = {}) {
  const found = [];
  if (env.DEPLOY_CHROMIUM) found.push(env.DEPLOY_CHROMIUM);
  const cache = playwrightCache(env, platform, home);
  let folders = [];
  try {
    folders = list(cache);
  } catch {
    folders = [];
  }
  const revision = (name) => Number(/-(\d+)$/.exec(name)?.[1] ?? 0);
  for (const kind of ['chromium_headless_shell', 'chromium'])
    for (const name of folders
      .filter((entry) => entry.startsWith(`${kind}-`))
      .sort((a, b) => revision(b) - revision(a)))
      found.push(...playwrightExecutables(join(cache, name), platform));
  if (platform === 'darwin')
    for (const app of [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Chromium.app/Contents/MacOS/Chromium',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Brave Browser.app/Contents/MacOS/Brave Browser',
    ])
      found.push(join('/Applications', app), join(home, 'Applications', app));
  else if (platform === 'win32')
    for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(
      Boolean,
    ))
      found.push(
        join(base, 'Google/Chrome/Application/chrome.exe'),
        join(base, 'Microsoft/Edge/Application/msedge.exe'),
      );
  else
    found.push(
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/snap/bin/chromium',
      '/usr/bin/microsoft-edge',
    );
  return [...new Set(found)].filter((path) => exists(path));
}

/** What to run when no browser was found. */
export const browserFix = 'deploy browser install';

/** One DevTools connection: commands by ID, events by name, per session. */
function connect(url) {
  const socket = new WebSocket(url);
  let next = 1;
  const waiting = new Map();
  const listeners = new Set();
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Chromium refused the connection')), {
      once: true,
    });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && waiting.has(message.id)) {
      const { resolve, reject } = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    } else if (message.method) for (const listener of listeners) listener(message);
  });
  socket.addEventListener('close', () => {
    for (const { reject } of waiting.values()) reject(new Error('Chromium went away'));
    waiting.clear();
  });
  return {
    opened,
    send(method, params = {}, sessionId) {
      const id = next++;
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => socket.close(),
  };
}

const withTimeout = (promise, ms, message) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref?.();
    }),
  ]);

/**
 * Starts a headless browser. Resolves to { executable, newTab({ width, height, scheme }), close },
 * where a tab can setContent(html), evaluate(expression), screenshot({ fullPage }) and close().
 * Pages load from a file in a private folder and reach nothing on the network.
 */
export async function launchChromium(executable, { timeoutMs = 20000 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'deploy-design-chromium-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--font-render-hinting=none',
    '--force-color-profile=srgb',
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    'about:blank',
  ];
  const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const cleanup = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  };
  let endpoint;
  try {
    endpoint = await withTimeout(
      new Promise((resolve, reject) => {
        let text = '';
        child.stderr.on('data', (chunk) => {
          text += chunk;
          const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
          if (match) resolve(match[1]);
          if (text.length > 64000) text = text.slice(-4000);
        });
        child.once('error', (error) => reject(error));
        child.once('exit', (code) =>
          reject(
            new Error(
              `Chromium stopped at start (${code}): ${text.trim().split('\n').at(-1) ?? ''}`,
            ),
          ),
        );
      }),
      timeoutMs,
      'Chromium did not start in time',
    );
  } catch (error) {
    cleanup();
    throw error;
  }
  child.stderr.resume();
  const cdp = connect(endpoint);
  try {
    await withTimeout(cdp.opened, timeoutMs, 'Chromium did not answer');
  } catch (error) {
    cleanup();
    throw error;
  }
  const pages = mkdtempSync(join(tmpdir(), 'deploy-design-pages-'));
  let pageCount = 0;

  async function newTab({ width, height, scheme = 'light' }) {
    const { browserContextId } = await cdp.send('Target.createBrowserContext', {
      disposeOnDetach: true,
    });
    const { targetId } = await cdp.send('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
    });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);
    await send('Page.enable');
    await send('Network.enable');
    await send('Network.setBlockedURLs', { urls: ['http://*', 'https://*', 'ws://*', 'wss://*'] });
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: scheme }],
    });
    await send('Emulation.setScriptExecutionDisabled', { value: true });
    const files = [];
    return {
      async setContent(html) {
        const file = join(pages, `page-${++pageCount}.html`);
        writeFileSync(file, html);
        files.push(file);
        await this.goto(pathToFileURL(file).href);
      },
      /** Loads a file:// page (the network stays shut), waiting for its load event. */
      async goto(url) {
        const loaded = new Promise((resolve) => {
          const stop = cdp.on((message) => {
            if (message.sessionId === sessionId && message.method === 'Page.loadEventFired') {
              stop();
              resolve();
            }
          });
        });
        await send('Page.navigate', { url });
        await withTimeout(loaded, 15000, 'The board did not finish loading');
      },
      async evaluate(expression) {
        const result = await send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        if (result.exceptionDetails)
          throw new Error(
            result.exceptionDetails.exception?.description?.split('\n')[0] ??
              result.exceptionDetails.text,
          );
        return result.result.value;
      },
      async screenshot({ fullPage = false } = {}) {
        let clip;
        if (fullPage) {
          const size = await this.evaluate(
            '({ width: document.documentElement.scrollWidth, height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) })',
          );
          clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
        }
        const { data } = await send('Page.captureScreenshot', {
          format: 'png',
          ...(clip ? { clip, captureBeyondViewport: true } : {}),
        });
        return Buffer.from(data, 'base64');
      },
      async close() {
        await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
        for (const file of files) rmSync(file, { force: true });
      },
    };
  }

  return {
    executable,
    newTab,
    async close() {
      await withTimeout(cdp.send('Browser.close'), 3000, 'closing').catch(() => {});
      cdp.close();
      cleanup();
      rmSync(pages, { recursive: true, force: true });
    },
  };
}

/**
 * The first browser here that starts, or null with why none did. Each is tried in turn, so a
 * broken Playwright download falls back to the computer's Chrome.
 */
export async function openChromium(options = {}) {
  const candidates = options.candidates ?? chromiumCandidates(options);
  if (!candidates.length)
    return { browser: null, reason: 'no Chromium or Chrome on this computer' };
  let reason = '';
  for (const executable of candidates) {
    try {
      return { browser: await launchChromium(executable, options) };
    } catch (error) {
      reason = String(error?.message ?? error).split('\n')[0];
    }
  }
  return { browser: null, reason };
}
