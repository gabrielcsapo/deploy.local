// The browser `deploy design check` draws boards with on this computer: Playwright's Chromium if it
// was installed (deploy browser install, or a project's own Playwright), else the computer's Chrome,
// Chromium or Edge. It is driven over the DevTools protocol on a pipe (no port, no network), so the
// CLI needs no Playwright of its own: the standalone binary and a fresh worktree draw the same way,
// and so does a sandbox that forbids sockets.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * One DevTools connection over the pipe Chromium opens on its file descriptors 3 and 4
 * (--remote-debugging-pipe): messages are JSON ended by a NUL. No port and no socket, so a
 * sandbox that forbids the network still lets the check talk to its browser.
 */
function connect(input, output) {
  let next = 1;
  let pending = '';
  let closed = false;
  const waiting = new Map();
  const listeners = new Set();
  const fail = () => {
    closed = true;
    for (const { reject } of waiting.values()) reject(new Error('Chromium went away'));
    waiting.clear();
  };
  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\0')) >= 0) {
      const message = JSON.parse(pending.slice(0, end));
      pending = pending.slice(end + 1);
      if (message.id && waiting.has(message.id)) {
        const { resolve, reject } = waiting.get(message.id);
        waiting.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) for (const listener of listeners) listener(message);
    }
  });
  output.on('close', fail);
  output.on('error', fail);
  input.on('error', fail);
  return {
    send(method, params = {}, sessionId) {
      if (closed) return Promise.reject(new Error('Chromium went away'));
      const id = next++;
      input.write(
        `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`,
      );
      return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      closed = true;
      input.end();
    },
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
/**
 * Chromium's flags for a sandbox (Codex's, a container): no setuid or seatbelt sandbox of its
 * own inside the outer one, no crash reporter writing outside the work folder, no GPU process,
 * and one process: on a Mac a sandbox that forbids registering Mach services stops Chromium at
 * its child-process rendezvous (bootstrap_check_in), which a single process never needs.
 */
export const sandboxFlags = [
  '--no-sandbox',
  '--single-process',
  '--no-zygote',
  '--disable-gpu-sandbox',
  '--disable-crash-reporter',
  '--disable-crashpad',
  '--disable-breakpad',
  '--disable-dev-shm-usage',
  '--use-mock-keychain',
  '--password-store=basic',
];

/**
 * Starts a headless browser. Resolves to { executable, newTab({ width, height, scheme, scale,
 * media }), close }, where a tab can setContent(html), goto(url), evaluate(expression),
 * screenshot({ fullPage }) and close(); `scale` is device pixels per CSS pixel and `media` may be
 * "print" to draw with the page's print styles. Pages load from files in `workDir` (else the system's temporary folder) and reach
 * nothing on the network. With `sandboxed`, the profile and temporary files also live in
 * `workDir` and Chromium runs with sandboxFlags.
 */
export async function launchChromium(
  executable,
  { timeoutMs = 20000, workDir = null, sandboxed = false } = {},
) {
  const root = workDir ?? tmpdir();
  mkdirSync(root, { recursive: true });
  const profile = mkdtempSync(join(root, 'chromium-'));
  const temporary = join(profile, 'tmp');
  mkdirSync(temporary, { recursive: true });
  const args = [
    '--headless=new',
    '--remote-debugging-pipe',
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
    ...(sandboxed ? sandboxFlags : process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    'about:blank',
  ];
  const env = sandboxed
    ? { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary, HOME: profile }
    : process.env;
  const child = spawn(executable, args, {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    env,
  });
  const cleanup = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  };
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const cdp = connect(child.stdio[3], child.stdio[4]);
  try {
    // The first answer says the pipe is up; an early exit says why it is not.
    await withTimeout(
      Promise.race([
        cdp.send('Browser.getVersion'),
        new Promise((_, reject) => {
          child.once('error', reject);
          child.once('exit', (code, signal) =>
            reject(
              new Error(
                `Chromium stopped at start (${code ?? signal}): ${stderr.trim().split('\n').at(-1) ?? ''}`,
              ),
            ),
          );
        }),
      ]),
      timeoutMs,
      'Chromium did not start in time',
    );
  } catch (error) {
    cleanup();
    throw error;
  }
  const pages = mkdtempSync(join(root, 'pages-'));
  let pageCount = 0;

  async function newTab({ width, height, scheme = 'light', scale = 1, media = null }) {
    // A context of its own per tab; one process (in a sandbox) has only the default one.
    const { browserContextId } = sandboxed
      ? { browserContextId: undefined }
      : await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
    const { targetId } = await cdp.send('Target.createTarget', {
      url: 'about:blank',
      ...(browserContextId ? { browserContextId } : {}),
    });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);
    await send('Page.enable');
    await send('Network.enable');
    await send('Network.setBlockedURLs', { urls: ['http://*', 'https://*', 'ws://*', 'wss://*'] });
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: scale,
      mobile: false,
    });
    await send('Emulation.setEmulatedMedia', {
      ...(media ? { media } : {}),
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
        await (
          browserContextId
            ? cdp.send('Target.disposeBrowserContext', { browserContextId })
            : cdp.send('Target.closeTarget', { targetId })
        ).catch(() => {});
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
  // As usual first; then as a sandbox needs it (its own sandbox and crash reporter off, every
  // file in the work folder); then the next browser.
  const attempts = [false, true];
  const reasons = [];
  for (const executable of candidates)
    for (const sandboxed of attempts) {
      try {
        return {
          browser: await launchChromium(executable, { ...options, sandboxed }),
          sandboxed,
        };
      } catch (error) {
        reasons.push(String(error?.message ?? error).split('\n')[0]);
      }
    }
  return { browser: null, reason: reasons.at(-1) ?? 'Chromium did not start' };
}
