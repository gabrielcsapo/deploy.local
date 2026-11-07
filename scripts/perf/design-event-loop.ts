/**
 * How long the design routes stall the server's event loop, on a large throwaway repository.
 * Runs a real v2 server in a child process, on its own temporary data directory, and removes it
 * all afterwards. It never reads ~/.deployrc and never talks to another server.
 *
 * Usage: node scripts/perf/design-event-loop.ts [--boards 312] [--files 20000] [--commits 3000]
 *                                               [--samples 5] [--slow-git 50] [--json out.json]
 *
 * Each scenario reports the route's own time and, while it ran, the server's event-loop delay
 * (monitorEventLoopDelay) and the latency of a Git-free request sent every 25 ms alongside it,
 * which is what everyone else using the server feels. `--slow-git` puts a delay in front of every
 * Git process, for a slow disk or a very large repository.
 */
import { fork, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const option = (name: string, fallback: number) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : Number(process.argv[at + 1]);
};

if (process.argv.includes('--server')) await serve();
else await measure();

/** The child: a real v2 server, and its event-loop histogram on request. */
async function serve() {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  const { save } = await import('../../server/workspace/store.ts');
  const { v2Api } = await import('../../server/v2/api.ts');
  save('project', 'perf', {
    id: 'site',
    name: 'Site',
    repositoryPath: process.env.PERF_REPOSITORY,
    repositoryStatus: 'ready',
  });
  const server = createServer((req, res) => {
    void v2Api(req, res, () => ({ username: 'perf' }));
  });
  // A long stall must show up as latency here, not as connections the server closed meanwhile.
  server.keepAliveTimeout = 0;
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  process.once('disconnect', () => process.exit(0));
  server.listen(0, '127.0.0.1', () => {
    process.send!({ port: (server.address() as import('node:net').AddressInfo).port });
  });
  process.on('message', (message: string) => {
    if (message === 'stop') process.exit(0);
    process.send!({
      maxMs: histogram.max / 1e6,
      p99Ms: histogram.percentile(99) / 1e6,
    });
    histogram.reset();
  });
}

/** One fast-import stream: main with boards and history, and design branches off it. */
function buildRepository(repo: string, sizes: { boards: number; files: number; commits: number }) {
  spawnSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', repo], {
    stdio: 'ignore',
  });
  const importer = spawn('git', ['-C', repo, 'fast-import', '--quiet'], {
    stdio: ['pipe', 'ignore', 'inherit'],
  });
  const write = (text: string) => importer.stdin.write(text);
  const file = (path: string, content: string) =>
    write(`M 100644 inline ${path}\ndata ${Buffer.byteLength(content)}\n${content}\n`);
  let mark = 0;
  const commit = (ref: string, message: string, from?: string) => {
    mark += 1;
    write(`commit ${ref}\nmark :${mark}\n`);
    write(`committer Perf <perf@example.invalid> ${1700000000 + mark} +0000\n`);
    write(`data ${message.length}\n${message}\n`);
    if (from) write(`from ${from}\n`);
    return `:${mark}`;
  };
  const names = Array.from({ length: sizes.boards }, (_, n) => `Board${n}.html`);
  // Real boards here average about 30 KB: the same markup repeated, with instances and links.
  const board = (n: number, title: string) => {
    const rows = Array.from(
      { length: 150 },
      (_, row) =>
        `<div data-layer="row-${row}" class="dl-row"><span data-layer="label-${row}">Row ${row} of board ${n}</span><a data-layer="link-${row}" data-link="${names[(n + row + 1) % names.length]}" href="#">Open the next board</a></div>`,
    ).join('\n');
    return `<!doctype html>
<html lang="en"><head><title>${title}</title>
<link rel="stylesheet" href="../ds/deploy-local/tokens.css">
</head><body>
<h1 data-layer="title">${title}</h1>
<div data-layer="notice" data-component="notice" data-props="{}"><p>Notice</p></div>
${rows}
</body></html>
`;
  };
  const canvas = (notes: Record<string, unknown> = {}) =>
    `${JSON.stringify(
      {
        title: 'Perf',
        boards: Object.fromEntries(
          names.map((name, n) => [
            name,
            { x: (n % 20) * 1500, y: Math.floor(n / 20) * 1000, w: 1440, h: 900, title: name },
          ]),
        ),
        order: names,
        notes,
      },
      null,
      2,
    )}\n`;
  const library = (description: string) =>
    `${JSON.stringify({
      components: [{ id: 'notice', name: 'Notice', description, props: [], html: '<p>Notice</p>' }],
    })}\n`;
  const libraryFile = 'design/ds/deploy-local/components/library.json';

  commit('refs/heads/main', 'Add the design and the code');
  file('design/canvas.json', canvas());
  file('design/ds/deploy-local/tokens.css', ':root{--ink:#18181b}\n');
  file(libraryFile, library('first'));
  names.forEach((name, n) => file(`design/boards/${name}`, board(n, name)));
  for (let n = 0; n < sizes.files; n += 1)
    file(`src/area-${n % 200}/module-${n}.ts`, `export const value${n} = ${n};\n`);
  let start = `:${mark}`;
  for (let n = 0; n < sizes.commits; n += 1) {
    start = commit('refs/heads/main', `Change ${n}`);
    file(
      `src/area-${n % 200}/module-${(n * 7) % sizes.files}.ts`,
      `export const changed = ${n};\n`,
    );
  }

  const proposals = [
    ...Array.from({ length: 12 }, (_, n) => ({ name: `waiting-${n}`, boards: 8, at: n * 10 })),
    ...Array.from({ length: 4 }, (_, n) => ({ name: `large-${n}`, boards: 40, at: 120 + n })),
    // Apart, so approving one leaves the next without conflicts.
    ...Array.from({ length: 4 }, (_, n) => ({ name: `approve-${n}`, boards: 40, at: n * 40 })),
    ...Array.from({ length: 6 }, (_, n) => ({ name: `propose-${n}`, boards: 40, at: 220 + n })),
  ];
  for (const proposal of proposals) {
    commit(`refs/heads/design/${proposal.name}`, `Design ${proposal.name}`, start);
    for (let n = 0; n < proposal.boards; n += 1) {
      const index = (proposal.at + n) % names.length;
      file(`design/boards/${names[index]}`, board(index, `${proposal.name} ${n}`));
    }
    if (proposal.name === 'approve-0') file(libraryFile, library('approved'));
  }
  commit('refs/heads/design/edits', 'Start the edits', start);
  file('design/ds/deploy-local/edits.css', '/* edits */\n');
  importer.stdin.end();
  return new Promise<void>((resolve, reject) =>
    importer.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`git fast-import exited ${code}`)),
    ),
  );
}

async function measure() {
  const sizes = {
    boards: option('boards', 312),
    files: option('files', 20000),
    commits: option('commits', 3000),
  };
  const samples = option('samples', 5);
  const slowGit = option('slow-git', 0);
  const root = mkdtempSync(join(tmpdir(), 'design-perf-'));
  const repo = join(root, 'repository.git');
  let child: ReturnType<typeof fork> | undefined;
  try {
    const built = performance.now();
    await buildRepository(repo, sizes);
    console.log(
      `${sizes.boards} boards, ${sizes.files} other files, ${sizes.commits} commits; Git delay ${slowGit} ms; built in ${Math.round(performance.now() - built)} ms`,
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DEPLOY_DATA_DIR: join(root, 'data'),
      PERF_REPOSITORY: repo,
      // Nothing to draw with: proposing warms the review's Git reads, then stops at the first board.
      PLAYWRIGHT_BROWSERS_PATH: join(root, 'no-browsers'),
    };
    if (slowGit) {
      const shim = join(root, 'shim');
      mkdirSync(shim);
      const real = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
      writeFileSync(join(shim, 'git'), `#!/bin/sh\nsleep ${slowGit / 1000}\nexec ${real} "$@"\n`);
      chmodSync(join(shim, 'git'), 0o755);
      env.PATH = `${shim}:${process.env.PATH}`;
    }
    child = fork(fileURLToPath(import.meta.url), ['--server'], { env, stdio: 'inherit' });
    const server = child;
    server.once('exit', (code, signal) => {
      if (code || signal) console.error(`The server exited: ${code ?? signal}`);
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.once('message', (message: any) => resolve(message.port));
      server.once('exit', () => reject(new Error('The server did not start')));
    });
    const origin = `http://127.0.0.1:${port}`;
    const design = `/api/v2/projects/site/design`;
    const call = async (path: string, body?: unknown) => {
      const response = await fetch(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (response.status >= 400)
        throw new Error(`${path} answered ${response.status}: ${bytes.toString().slice(0, 300)}`);
      return bytes;
    };
    const json = async (path: string, body?: unknown) =>
      JSON.parse((await call(path, body)).toString());
    const stats = () =>
      new Promise<{ maxMs: number; p99Ms: number }>((resolve) => {
        server.once('message', (message: any) => resolve(message));
        server.send('stats');
      });
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    // A review's warm-up runs after propose answers, and its stall belongs to propose.
    const settle = 1000 + 250 * slowGit;

    const rows: Record<string, unknown>[] = [];
    const scenario = async (name: string, work: () => Promise<number[]>) => {
      await stats();
      const bystander: number[] = [];
      let running = true;
      const watch = (async () => {
        while (running) {
          const sent = performance.now();
          await call(`${design}/presence`).catch((error) => {
            console.error(`The other request failed: ${error.message}`);
          });
          bystander.push(performance.now() - sent);
          await sleep(25);
        }
      })();
      let times: number[];
      try {
        times = await work();
      } finally {
        running = false;
        await watch;
      }
      const loop = await stats();
      times.sort((a, b) => a - b);
      bystander.sort((a, b) => a - b);
      const row = {
        scenario: name,
        routeMedianMs: Math.round(times[Math.floor(times.length / 2)]),
        routeWorstMs: Math.round(times.at(-1)!),
        loopMaxMs: Math.round(loop.maxMs),
        loopP99Ms: Math.round(loop.p99Ms),
        otherMedianMs: Math.round(bystander[Math.floor(bystander.length / 2)] ?? 0),
        otherWorstMs: Math.round(bystander.at(-1) ?? 0),
      };
      rows.push(row);
      console.log(
        `${name.padEnd(30)} route ${String(row.routeMedianMs).padStart(6)} / ${String(row.routeWorstMs).padStart(6)} ms   loop max ${String(row.loopMaxMs).padStart(6)} p99 ${String(row.loopP99Ms).padStart(6)} ms   other request ${String(row.otherMedianMs).padStart(5)} / ${String(row.otherWorstMs).padStart(6)} ms`,
      );
    };
    const timed = async (work: () => Promise<unknown>) => {
      const started = performance.now();
      await work();
      return performance.now() - started;
    };
    const repeat = async (count: number, work: (n: number) => Promise<unknown>) => {
      const times: number[] = [];
      for (let n = 0; n < count; n += 1) times.push(await timed(() => work(n)));
      return times;
    };

    // Reviews waiting, as on a busy project. Their warm-ups are not measured.
    const propose = async (name: string) =>
      (await json(`${design}/propose`, { ref: `design/${name}`, title: name })).item.id as string;
    for (let n = 0; n < 12; n += 1) await propose(`waiting-${n}`);
    const large = await propose('large-0');
    const approvals: string[] = [];
    for (let n = 0; n < 4; n += 1) approvals.push(await propose(`approve-${n}`));
    await sleep(settle);

    const { commit, canvas } = await json(design);
    const boards = Object.keys(canvas.boards) as string[];
    const firstLoad = [
      design,
      '/api/v2/design/projects',
      '/api/v2/design/reviews?project=site',
      `${design}/proposals`,
      `${design}/presence`,
      `${design}/comments`,
      `${design}/asks`,
      `${design}/components`,
    ];
    await scenario('page load: reads together', () =>
      repeat(samples, () => Promise.all(firstLoad.map((path) => call(path)))),
    );
    // The canvas opens a board's iframe per board in view, and they all arrive at once.
    await scenario('page load: 48 boards at once', () =>
      repeat(samples, (round) =>
        Promise.all(
          boards
            .slice(round, round + 48)
            .map((board) => call(`${design}/files/${commit}/boards/${board}`)),
        ),
      ),
    );
    await scenario(`every board (${boards.length})`, () =>
      repeat(1, async () => {
        let next = 0;
        await Promise.all(
          Array.from({ length: 32 }, async () => {
            while (next < boards.length)
              await call(`${design}/files/${commit}/boards/${boards[next++]}`);
          }),
        );
      }),
    );
    await scenario('GET /design', () => repeat(samples, () => call(design)));
    await scenario('GET /design/reviews', () =>
      repeat(samples, () => call('/api/v2/design/reviews?project=site')),
    );
    await scenario('GET /design/links (uncached)', () =>
      repeat(Math.min(samples, 4), (n) => call(`${design}/links?ref=design/large-${n}`)),
    );
    await scenario('GET /design/changes', () =>
      repeat(samples, () => call(`${design}/changes?ref=design/large-0`)),
    );
    const item = encodeURIComponent(large);
    await scenario('GET /design/review (40 boards)', () =>
      repeat(samples, () => call(`${design}/review?item=${item}`)),
    );
    const review = await json(`${design}/review?item=${item}`);
    const screen = review.boards[0];
    await scenario('POST /design/review/pins', () =>
      repeat(samples, (n) =>
        call(`${design}/review/pins`, {
          item: large,
          board: screen.file,
          revision: screen.after,
          width: screen.widths[0],
          x: 10 + n,
          y: 10,
          text: `Pin ${n}`,
        }),
      ),
    );
    await scenario('POST /design/review/seen', () =>
      repeat(samples, () =>
        call(`${design}/review/seen`, {
          item: large,
          board: screen.file,
          revision: screen.after,
        }),
      ),
    );
    await scenario('POST /design/edit', () =>
      repeat(samples, (n) =>
        call(`${design}/edit`, {
          ref: 'design/edits',
          board: boards[n],
          edits: [{ op: 'text', layer: 'title', value: `Edited ${n}`, text: `Edited ${n}` }],
        }),
      ),
    );
    await scenario('POST /design/canvas', () =>
      repeat(samples, (n) =>
        call(`${design}/canvas`, {
          ref: 'design/edits',
          op: 'note',
          x: n,
          y: n,
          text: `Note ${n}`,
        }),
      ),
    );
    await scenario('POST /design/branches', () =>
      repeat(samples, (n) => call(`${design}/branches`, { name: `perf branch ${n}` })),
    );
    await scenario('POST /design/propose (40 boards)', async () => {
      const times = await repeat(Math.min(samples, 6), (n) => propose(`propose-${n}`));
      await sleep(settle);
      return times;
    });
    const approve = (id: string) =>
      call(`/api/v2/inbox/${encodeURIComponent(id)}/answer`, { actionId: 'approve', on: 'web' });
    await scenario('approve (40 boards)', () =>
      repeat(approvals.length - 1, (n) => approve(approvals[n + 1])),
    );
    // A change to the component library renders every instance on main again, so this comes last.
    await scenario(`approve (library, ${boards.length} boards)`, () =>
      repeat(1, () => approve(approvals[0])),
    );

    const out = process.argv.indexOf('--json');
    if (out >= 0)
      writeFileSync(process.argv[out + 1], JSON.stringify({ sizes, slowGit, rows }, null, 2));
  } finally {
    child?.send('stop');
    await new Promise((resolve) => setTimeout(resolve, 100));
    child?.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
}
