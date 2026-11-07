// Measure the design review over this repository's own design/ (312 boards): a proposal that
// changes 20 boards and adds 2, the size of a real review. The v2 API runs in this process over a
// clone with a test owner, so timings include the Git work the server does for each request.
//   pnpm exec tsx scripts/perf/design-review.mjs [--samples 5] [--browser] [--scale 2]
// --browser also opens the pages in headless Chromium through Vite and times what a person sees.
// Each number is the median of the samples; the cold grid (Chromium renders) runs once.
import cp, { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const samples = Number(option('--samples', 5));
const scale = Number(option('--scale', 2));
// --keep leaves the API and Vite running on their ports for a look in a real browser; --serve
// does only that, without measuring.
const serve = args.includes('--serve');
const keep = serve || args.includes('--keep');
const browser = serve || args.includes('--browser');
const vitePort = Number(option('--vite-port', 5195));
const throttle = Number(option('--throttle', 0));

// Count the Git processes the server starts per request.
let gitSpawns = 0;
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = cp[name];
  const counting = function (file, ...rest) {
    if (file === 'git') gitSpawns++;
    return original.call(this, file, ...rest);
  };
  if (original[promisify.custom]) counting[promisify.custom] = original[promisify.custom];
  cp[name] = counting;
}
syncBuiltinESMExports();

const root = mkdtempSync(join(tmpdir(), 'design-perf-'));
process.env.DEPLOY_DATA_DIR = root;
const { get: read, save } = await import('../../server/workspace/store.ts');
const { v2Api } = await import('../../server/v2/api.ts');
const { designReview, proposeDesign } = await import('../../server/v2/design.ts');

// The fixture: this repository cloned, main at this commit, design/perf changing 20 boards and adding 2.
const source = resolve(import.meta.dirname, '../..');
const repo = join(root, 'source');
const git = (...rest) => execFileSync('git', ['-C', repo, ...rest], { encoding: 'utf8' }).trim();
execFileSync('git', ['clone', '-q', source, repo]);
git('checkout', '-q', '-B', 'main');
git('config', 'user.name', 'Perf');
git('config', 'user.email', 'perf@deploy.local');
git('checkout', '-q', '-b', 'design/perf');
const canvas = JSON.parse(readFileSync(join(repo, 'design/canvas.json'), 'utf8'));
const order = canvas.order ?? Object.keys(canvas.boards);
const changed = [
  ...order.filter((file) => canvas.boards[file].w > 500).slice(0, 12),
  ...order.filter((file) => canvas.boards[file].w <= 500).slice(0, 8),
];
for (const file of changed) {
  const path = join(repo, 'design/boards', file);
  const html = readFileSync(path, 'utf8');
  // One element's words change on each board, like an agent's edit.
  const next = html.replace(
    /(<[a-z0-9]+ [^>]*data-layer="[^"]+"[^>]*>)([^<]{3,60})(<)/,
    '$1$2 (revised)$3',
  );
  if (next === html) throw new Error(`No layer with words to change in ${file}`);
  writeFileSync(path, next);
}
const added = ['PerfNewOne.html', 'PerfNewTwo.html'];
for (const file of added) {
  copyFileSync(join(repo, 'design/boards/Welcome.html'), join(repo, 'design/boards', file));
  canvas.boards[file] = { ...canvas.boards['Welcome.html'], y: 90000, title: file.slice(0, -5) };
  order.push(file);
}
canvas.order = order;
writeFileSync(join(repo, 'design/canvas.json'), `${JSON.stringify(canvas, null, 2)}\n`);
git('add', '-A');
git('commit', '-q', '-m', 'Perf proposal');
git('checkout', '-q', 'main');
const owner = 'Gabriel';
save('project', owner, {
  id: 'deploy-local',
  name: 'deploy.local',
  repositoryPath: repo,
  repositoryStatus: 'ready',
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;
  const send = (value, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  if (path.startsWith('/api/')) {
    // The shell's own reads, enough for the pages to load in a browser.
    if (path === '/api/v2/events' || path.endsWith('/stream')) {
      // The newest cursor answers at once, as the server does; a long poll waits like one.
      if (url.searchParams.get('after') === 'latest')
        return send({ events: [], cursor: 1, supportsWait: true });
      const timer = setTimeout(() => send({ events: [], cursor: 1, supportsWait: true }), 15000);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (path === '/api/user') return send({ username: owner, role: 'admin' });
    if (path === '/api/v2/auth/account')
      return send({ username: owner, welcomed: true, firstTaskSeen: true, passkeyOffered: true });
    if (path === '/api/nodes')
      return send({ nodes: [{ id: 'coordinator', name: 'SER', online: true }] });
    if (path === '/api/workspace/state')
      return send({
        version: 1,
        cursor: 0,
        projects: [{ id: 'deploy-local', name: 'deploy.local', apps: [] }],
        workers: [],
        tasks: [],
        runs: [],
        adapters: [],
      });
    if (path === '/api/v2/live')
      return send({
        summary: { running: 0, failing: 0, warning: 0, checkedAt: new Date().toISOString() },
        computers: [],
      });
    if (path.startsWith('/api/v2/')) {
      await v2Api(req, res, () => ({ username: owner }));
      if (res.writableEnded || res.headersSent) return;
    }
    return send({ error: `No route: ${req.method} ${path}` }, 404);
  }
  const proxy = httpRequest(
    {
      hostname: '127.0.0.1',
      port: vitePort,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    },
  );
  proxy.on('error', () => send({ error: 'Vite is not running' }, 503));
  req.pipe(proxy);
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const origin = `http://127.0.0.1:${server.address().port}`;
const api = `${origin}/api/v2/projects/deploy-local/design`;

async function get(path) {
  const started = performance.now();
  const spawnsBefore = gitSpawns;
  const response = await fetch(origin + path);
  const bytes = (await response.arrayBuffer()).byteLength;
  if (!response.ok) throw new Error(`${response.status} ${path}`);
  return { ms: performance.now() - started, bytes, spawns: gitSpawns - spawnsBefore };
}
async function json(path) {
  const response = await fetch(origin + path);
  if (!response.ok) throw new Error(`${response.status} ${path}: ${await response.text()}`);
  return response.json();
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const row = (label, values) =>
  console.log(`${label.padEnd(56)} ${values.map((value) => String(value).padStart(10)).join('')}`);
const timed = async (label, run, extra = () => []) => {
  const results = [];
  for (let i = 0; i < samples; i++) results.push(await run());
  row(label, [
    `${Math.round(median(results.map((r) => r.ms)))} ms`,
    `${Math.round(median(results.map((r) => r.bytes)) / 1024)} KB`,
    `${median(results.map((r) => r.spawns ?? 0))} git`,
    ...extra(results),
  ]);
  return results;
};

const proposed = await fetch(`${api}/propose`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    ref: 'design/perf',
    title: 'Twenty screens revised and two new',
    summary: 'A proposal the size of a real review, to time the review against.',
  }),
});
if (proposed.status !== 201)
  throw new Error(`propose: ${proposed.status} ${await proposed.text()}`);
const item = (await proposed.json()).item;
const itemPath = encodeURIComponent(item.id);
// The proposal warms its renders in the background; wait so the cold grid is measured on its own.
await new Promise((done) => setTimeout(done, 500));

async function measureApi() {
  console.log(
    `Design review perf: ${changed.length} changed + ${added.length} new boards, scale ${scale}, ${samples} samples (median)`,
  );
  row('', ['time', 'bytes', 'git', '']);
  await timed('Design page: GET /design/reviews', () => get('/api/v2/design/reviews'));
  await timed('Design page: GET /design/projects', () => get('/api/v2/design/projects'));
  await timed('Design page: both in parallel (first useful view data)', async () => {
    const started = performance.now();
    const spawnsBefore = gitSpawns;
    const both = await Promise.all([get('/api/v2/design/reviews'), get('/api/v2/design/projects')]);
    return {
      ms: performance.now() - started,
      bytes: both[0].bytes + both[1].bytes,
      spawns: gitSpawns - spawnsBefore,
    };
  });
  await timed('Open review: GET /review?item (also every 30 s poll)', () =>
    get(`${api.slice(origin.length)}/review?item=${itemPath}`),
  );
  // The review's first computation, as after a restart: the same changes proposed from another
  // branch at a new commit, read directly so that nothing warms it first.
  await timed('Review built for the first time (direct, per revision)', async () => {
    const branch = `design/perf-cold-${Math.random().toString(36).slice(2, 8)}`;
    git('checkout', '-q', '-b', branch, 'design/perf');
    writeFileSync(join(repo, 'design/boards/PerfNewOne.html'), `<!-- ${branch} -->\n`, {
      flag: 'a',
    });
    git('commit', '-qam', 'Another revision');
    git('checkout', '-q', 'main');
    const project = read('project', owner, 'deploy-local');
    const made = proposeDesign(owner, project, { ref: branch });
    const row = read('v2-inbox-native', owner, made.id);
    const spawnsBefore = gitSpawns;
    const started = performance.now();
    designReview(owner, project, row);
    return { ms: performance.now() - started, bytes: 0, spawns: gitSpawns - spawnsBefore };
  });
  const review = await json(`${api.slice(origin.length)}/review?item=${itemPath}`);

  // The grid, as the web client loads it: three workers, each a preview then its two images.
  async function grid(boards, workers = 3) {
    const queue = boards.map((board) => ({ file: board.file, width: board.widths[0] }));
    const started = performance.now();
    const spawnsBefore = gitSpawns;
    let requests = 0,
      bytes = 0,
      firstTile = 0;
    const work = async () => {
      while (queue.length) {
        const next = queue.shift();
        const response = await fetch(
          `${api}/review/preview?item=${itemPath}&board=${encodeURIComponent(next.file)}&width=${next.width}&scale=${scale}`,
        );
        const preview = await response.json();
        if (!response.ok) throw new Error(preview.error);
        requests++;
        bytes += JSON.stringify(preview).length;
        await Promise.all(
          [preview.before, preview.after].filter(Boolean).map(async (src) => {
            const image = await fetch(origin + src);
            bytes += (await image.arrayBuffer()).byteLength;
            requests++;
          }),
        );
        if (!firstTile) firstTile = performance.now() - started;
      }
    };
    await Promise.all(Array.from({ length: workers }, work));
    return {
      ms: performance.now() - started,
      bytes,
      requests,
      firstTile,
      spawns: gitSpawns - spawnsBefore,
    };
  }
  const cold = await grid(review.boards);
  row('Grid, cold (renders every screen in Chromium), once', [
    `${Math.round(cold.ms)} ms`,
    `${Math.round(cold.bytes / 1024)} KB`,
    `${cold.spawns} git`,
    `${cold.requests} req`,
    `first tile ${Math.round(cold.firstTile)} ms`,
  ]);
  await timed(
    'Grid, warm: every screen at its first width',
    () => grid(review.boards),
    (results) => [
      `${median(results.map((r) => r.requests))} req`,
      `first tile ${Math.round(median(results.map((r) => r.firstTile)))} ms`,
    ],
  );
  const web = review.boards.find((board) => board.widths.length > 1);
  // Opening a screen already in the grid needs no request; looking at it marks it seen.
  await timed('Look at a screen: POST /review/seen', async () => {
    const started = performance.now();
    const spawnsBefore = gitSpawns;
    const response = await fetch(`${api}/review/seen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item: item.id, board: web.file, revision: review.after }),
    });
    const bytes = (await response.arrayBuffer()).byteLength;
    if (!response.ok) throw new Error(`seen: ${response.status}`);
    return { ms: performance.now() - started, bytes, spawns: gitSpawns - spawnsBefore };
  });
  await timed(`Switch ${web.file} to ${web.widths[1]} (preview + 2 images)`, async () => {
    const started = performance.now();
    const spawnsBefore = gitSpawns;
    const preview = await json(
      `${api.slice(origin.length)}/review/preview?item=${itemPath}&board=${encodeURIComponent(web.file)}&width=${web.widths[1]}&scale=${scale}`,
    );
    let bytes = JSON.stringify(preview).length;
    for (const src of [preview.before, preview.after]) if (src) bytes += (await get(src)).bytes;
    return { ms: performance.now() - started, bytes, spawns: gitSpawns - spawnsBefore };
  });
  await timed('Task Design tab: GET /changes?task-like ref', () =>
    get(`${api.slice(origin.length)}/changes?ref=design/perf`),
  );
  await timed('Task Design tab: GET /proposals', () =>
    get(`${api.slice(origin.length)}/proposals`),
  );
}
if (!serve) await measureApi();

if (browser) {
  execFileSync('node', ['scripts/flight-router.mjs'], { cwd: source, stdio: 'ignore' });
  const vite = spawn(
    'pnpm',
    ['exec', 'vite', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
    {
      cwd: source,
      env: { ...process.env, DEPLOY_DEV_API_ORIGIN: origin },
      stdio: ['ignore', 'ignore', 'inherit'],
      // Its own process group, so stopping it stops Vite itself and not only pnpm.
      detached: true,
    },
  );
  try {
    for (let i = 0; i < 100; i++) {
      await new Promise((done) => setTimeout(done, 300));
      try {
        if ((await fetch(`http://127.0.0.1:${vitePort}/`)).status) break;
      } catch {
        // Not up yet.
      }
    }
    if (!serve) {
      const { chromium } = await import('playwright');
      const browserInstance = await chromium.launch();
      const context = await browserInstance.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: scale,
      });
      await context.addInitScript((user) => {
        localStorage.setItem('deploy-sh-auth', JSON.stringify({ username: user, token: 'perf' }));
        localStorage.setItem('deploy-v2-first-task-seen', 'yes');
      }, owner);
      const page = await context.newPage();
      // --throttle <Mbps> emulates a slower link, like SER over Wi-Fi, with 20 ms of latency.
      if (throttle) {
        const session = await context.newCDPSession(page);
        // Without the browser cache, every sample moves every image over the slow link.
        await session.send('Network.setCacheDisabled', { cacheDisabled: true });
        await session.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 20,
          downloadThroughput: (throttle * 1024 * 1024) / 8,
          uploadThroughput: (throttle * 1024 * 1024) / 8,
        });
      }
      const counts = { requests: 0, bytes: 0 };
      page.on('response', async (response) => {
        if (!response.url().includes('/api/')) return;
        counts.requests++;
        try {
          counts.bytes += (await response.body()).byteLength;
        } catch {
          // Aborted responses have no body.
        }
      });
      const reset = () => Object.assign(counts, { requests: 0, bytes: 0 });
      // Warm Vite's transforms so module serving is not what is measured.
      await page.goto(`${origin}/dashboard/design?view=review`, { waitUntil: 'load' });
      await page.waitForSelector('.dl-review-content .dl-item');
      await page.goto(`${origin}/dashboard/inbox?item=${itemPath}`, { waitUntil: 'load' });
      await page.waitForSelector('.dl-review-image svg');
      await page.waitForSelector('text=/You.ve looked at/', { timeout: 120000 });
      console.log('');
      console.log(
        `Browser (Vite dev, headless Chromium, 1440×900, API requests only${throttle ? `, ${throttle} Mbps` : ''}):`,
      );
      row('', ['time', 'bytes', 'req', '']);
      const total = (await json(`${api.slice(origin.length)}/review?item=${itemPath}`)).boards
        .length;
      const nav = async (label, url, ready, after = async () => {}) => {
        const results = [];
        for (let i = 0; i < samples; i++) {
          reset();
          const started = performance.now();
          await page.goto(url, { waitUntil: 'commit' });
          if (typeof ready === 'function')
            await page.waitForFunction(ready, total, { timeout: 120000 });
          else await page.waitForSelector(ready, { timeout: 120000 });
          const ms = performance.now() - started;
          await after();
          results.push({ ms, requests: counts.requests, bytes: counts.bytes });
        }
        row(label, [
          `${Math.round(median(results.map((r) => r.ms)))} ms`,
          `${Math.round(median(results.map((r) => r.bytes)) / 1024)} KB`,
          `${median(results.map((r) => r.requests))} req`,
        ]);
      };
      await nav(
        'Design page: first proposal row visible',
        `${origin}/dashboard/design?view=review`,
        '.dl-review-content .dl-item',
      );
      await nav(
        'Review: first tile image visible',
        `${origin}/dashboard/inbox?item=${itemPath}`,
        '.dl-review-image svg',
      );
      await nav(
        'Review: every tile visible (bytes until the grid is whole)',
        `${origin}/dashboard/inbox?item=${itemPath}`,
        (count) => document.querySelectorAll('.dl-review-image svg').length >= count,
      );
      await nav(
        'Review: every tile loaded, decisions enabled',
        `${origin}/dashboard/inbox?item=${itemPath}`,
        'text=/You.ve looked at/',
      );
      const stepResults = [];
      for (let i = 0; i < samples; i++) {
        await page.goto(`${origin}/dashboard/inbox?item=${itemPath}`, { waitUntil: 'commit' });
        await page.waitForSelector('text=/You.ve looked at/', { timeout: 120000 });
        const tiles = page.locator('.dl-review-tile');
        let started = performance.now();
        await tiles.nth(0).click();
        await page.waitForSelector('.dl-review-shot-image');
        const open = performance.now() - started;
        reset();
        started = performance.now();
        await page.getByRole('button', { name: 'Next', exact: true }).click();
        await page.waitForSelector('.dl-review-viewer-head .dl-t:text-matches("^2 of")');
        await page.waitForSelector('.dl-review-shot-image');
        const next = performance.now() - started;
        started = performance.now();
        await page.click('.dl-seg[aria-label="Width"] >> text=700');
        await page.waitForFunction(
          () =>
            document.querySelector('.dl-review-shot-image img')?.getAttribute('width') === '700',
        );
        const width = performance.now() - started;
        stepResults.push({ open, next, width, requests: counts.requests, bytes: counts.bytes });
      }
      row('Open the first screen from the grid', [
        `${Math.round(median(stepResults.map((r) => r.open)))} ms`,
      ]);
      row('Next screen', [`${Math.round(median(stepResults.map((r) => r.next)))} ms`]);
      row('Switch the screen to 700', [
        `${Math.round(median(stepResults.map((r) => r.width)))} ms`,
        `${Math.round(median(stepResults.map((r) => r.bytes)) / 1024)} KB`,
        `${median(stepResults.map((r) => r.requests))} req`,
      ]);
      await browserInstance.close();
    }
    if (keep) {
      console.log(`Kept running: ${origin}/dashboard/inbox?item=${itemPath} (Ctrl-C to stop)`);
      await new Promise((stop) => process.once('SIGINT', stop));
    }
  } finally {
    try {
      process.kill(-vite.pid, 'SIGTERM');
    } catch {
      vite.kill('SIGTERM');
    }
  }
}

server.closeAllConnections();
await new Promise((done) => server.close(done));
rmSync(root, { recursive: true, force: true });
process.exit(0);
