// deploy design dev: the Design page on this folder, served on 127.0.0.1 until Ctrl-C. The page
// is deploy.local's own Design page, built to static files (see bin/design-local-assets.mjs); its
// data comes from the folder through server/design/local-design.ts. Each save reloads the page
// and is reported, with what is wrong with the board as saved.
import { watch } from 'node:fs';
import { createServer } from 'node:http';
import { createLocalDesign } from '../server/design/local-design.ts';
import { overflowProblems } from '../shared/v2/design-overflow.ts';

async function readJson(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 65536) return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const types = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  woff2: 'font/woff2',
  svg: 'image/svg+xml',
  png: 'image/png',
  json: 'application/json; charset=utf-8',
};

/**
 * Starts the page. `assets` maps a path ("index.html", "assets/…") to its bytes. `onSave` hears
 * { file, problems } for each board saved, once. While the page is open, a saved web board waits up
 * to `measureWait` ms for the page to measure it at 700 px (what leaves the page sideways), and its
 * line carries that too; a measurement after that is dropped. Resolves to { url, port, stopped, stop }.
 */
export async function serveDesignFolder({
  root,
  project,
  branch,
  main,
  deployUrl,
  machine,
  assets,
  designSystem,
  onSave = () => {},
  ports = [5199, 5198, 5197, 5196, 5195, 0],
  measureWait = 1000,
  signals = true,
}) {
  const local = createLocalDesign({ root, project, branch, main, designSystem });
  const listeners = new Set();
  // Saves whose line waits for the page's measurement, by number.
  const waiting = new Map();
  let saves = 0;
  const config = JSON.stringify({ project, branch, deployUrl, machine }).replace(/</g, '\\u003c');
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      // Only this computer, by its own name: a page elsewhere cannot reach the folder through it.
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? '')) {
        res.writeHead(403).end();
        return;
      }
      // Writes come only from this page: another site open in the browser cannot post here.
      const origin = req.headers.origin;
      if (
        !['GET', 'HEAD'].includes(req.method ?? 'GET') &&
        origin !== undefined &&
        origin !== `http://${req.headers.host}`
      ) {
        res.writeHead(403).end();
        return;
      }
      if (url.pathname === '/api/design-local/measured' && req.method === 'POST') {
        // The open page measured a saved board at 700: its line is printed with what it found.
        const body = await readJson(req);
        const shape = (value) =>
          value &&
          typeof value.scrolls === 'boolean' &&
          (value.cut === null || typeof value.cut === 'string')
            ? { scrolls: value.scrolls, cut: value.cut === null ? null : value.cut.slice(0, 40) }
            : null;
        const after = shape(body?.after);
        const known = waiting.has(String(body?.save ?? ''));
        if (after) finish(String(body.save), { after, before: shape(body.before) });
        res.writeHead(known && after ? 204 : 410).end();
        return;
      }
      if (url.pathname === '/api/design-local/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({ commit: local.version() })}\n\n`);
        const send = (commit, measure = []) =>
          res.write(`data: ${JSON.stringify({ commit, measure })}\n\n`);
        listeners.add(send);
        req.on('close', () => listeners.delete(send));
        return;
      }
      if (await local.handle(req, res)) return;
      if (url.pathname === '/' && !url.searchParams.has('project')) {
        res.writeHead(302, { Location: '/?project=local&view=canvas' }).end();
        return;
      }
      const path = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      let bytes = path.split('/').includes('..') ? null : assets[path];
      if (!bytes) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      if (path === 'index.html')
        bytes = Buffer.from(
          bytes
            .toString()
            .replace('<head>', `<head><script>window.__DEPLOY_DESIGN_LOCAL__=${config}</script>`),
        );
      res.writeHead(200, {
        'Content-Type': types[path.split('.').pop()] ?? 'application/octet-stream',
        'Content-Length': bytes.length,
        'Cache-Control': path === 'index.html' ? 'no-store' : 'max-age=3600',
      });
      res.end(bytes);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String(error?.message ?? error));
    }
  });
  let port;
  for (const candidate of ports) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(candidate, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      port = server.address().port;
      break;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || candidate === ports.at(-1)) throw error;
    }
  }

  // Saves come as bursts of events; each board is reported once the burst settles.
  const pending = new Set();
  let timer = null;
  let last = local.version();
  const settle = () => {
    timer = null;
    const files = [...pending];
    pending.clear();
    const now = local.version();
    if (now === last) return;
    last = now;
    // With the page open, each saved web board is measured there at 700 before its line prints.
    const measure = [];
    for (const file of files) {
      const problems = local.problems(file);
      const placed = local.placed(file) ?? { w: 1440, h: 900 };
      if (!listeners.size || placed.w <= 500) {
        onSave({ file, problems });
        continue;
      }
      const save = String(++saves);
      waiting.set(save, {
        file,
        problems,
        timer: setTimeout(() => finish(save, null), measureWait),
      });
      measure.push({ save, file, height: placed.h });
    }
    for (const send of listeners) send(now, measure);
  };
  /** A waiting save's line, once: with what the page measured, or as it is when nothing came. */
  function finish(save, measured) {
    const entry = waiting.get(save);
    if (!entry) return;
    waiting.delete(save);
    clearTimeout(entry.timer);
    const name = entry.file.replace(/\.html$/, '');
    const overflow = measured
      ? overflowProblems(entry.file, name, measured).map(({ short, detail }) => ({
          file: entry.file,
          short,
          detail,
        }))
      : [];
    onSave({ file: entry.file, problems: [...entry.problems, ...overflow] });
  }

  const watcher = watch(`${root}/design`, { recursive: true }, (_event, name) => {
    const path = String(name ?? '').replaceAll('\\', '/');
    const board = /^boards\/([A-Za-z0-9_-]+\.html)$/.exec(path);
    if (board) pending.add(board[1]);
    clearTimeout(timer);
    timer = setTimeout(settle, 150);
  });

  let stopped;
  const done = new Promise((resolve) => (stopped = resolve));
  const stop = () => {
    clearTimeout(timer);
    for (const save of [...waiting.keys()]) finish(save, null);
    watcher.close();
    server.closeAllConnections?.();
    server.close(() => stopped());
  };
  if (signals) process.once('SIGINT', stop);
  return { url: `http://localhost:${port}`, port, stopped: done, stop };
}
