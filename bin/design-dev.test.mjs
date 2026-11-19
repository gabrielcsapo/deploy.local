import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { serveDesignFolder } from './design-dev.mjs';

function folder() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'design-dev-')));
  mkdirSync(join(root, 'design/boards'), { recursive: true });
  writeFileSync(
    join(root, 'design/canvas.json'),
    JSON.stringify({ boards: { 'Harbor.html': { x: 0, y: 0, w: 1440, h: 900 } } }),
  );
  writeFileSync(join(root, 'design/boards/Harbor.html'), '<main data-layer="page">Harbor</main>');
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: root });
  return root;
}

/** A GET with its own Host header, as a page on another name would send it. */
const get = (port, path, host = `localhost:${port}`) =>
  new Promise((resolve, reject) =>
    request({ port, path, host: '127.0.0.1', headers: { host } }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    })
      .on('error', reject)
      .end(),
  );

/** The page's event stream: each message parsed, as the open Design page receives them. */
function watchPage(port) {
  const received = [];
  const wanted = [];
  const stream = request(
    {
      port,
      path: '/api/design-local/events',
      host: '127.0.0.1',
      headers: { host: `localhost:${port}` },
    },
    (res) =>
      res.on('data', (chunk) => {
        for (const line of String(chunk).split('\n'))
          if (line.startsWith('data: ')) received.push(JSON.parse(line.slice(6)));
        for (const want of [...wanted])
          if (received.length >= want.count) {
            wanted.splice(wanted.indexOf(want), 1);
            want.resolve(received.slice(0, want.count));
          }
      }),
  );
  stream.end();
  return {
    messages: (count) =>
      received.length >= count
        ? Promise.resolve(received.slice(0, count))
        : new Promise((resolve) => wanted.push({ count, resolve })),
    close: () => stream.destroy(),
  };
}

/** What the page posts after measuring a saved board, from the page's own origin. */
const measured = (port, body) =>
  new Promise((resolve, reject) =>
    request(
      {
        port,
        path: '/api/design-local/measured',
        host: '127.0.0.1',
        method: 'POST',
        headers: {
          host: `localhost:${port}`,
          origin: `http://localhost:${port}`,
          'content-type': 'application/json',
        },
      },
      (res) => (res.resume(), resolve(res.statusCode)),
    )
      .on('error', reject)
      .end(JSON.stringify(body)),
  );

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The page on a fresh folder, with every terminal line it prints. */
async function serve(extra = {}) {
  const root = folder();
  const saves = [];
  const page = await serveDesignFolder({
    root,
    project: 'catan',
    branch: 'design/harbor-trade',
    main: 'origin/main',
    deployUrl: 'https://deploy.local',
    machine: 'Mac',
    assets: { 'index.html': Buffer.from('<html><head></head></html>') },
    designSystem: () => null,
    onSave: (save) => saves.push({ ...save, at: Date.now() }),
    ports: [0],
    signals: false,
    ...extra,
  });
  const save = (text, file = 'Harbor.html') =>
    writeFileSync(join(root, 'design/boards', file), text);
  const close = async () => {
    page.stop();
    await page.stopped;
    rmSync(root, { recursive: true, force: true });
  };
  return { root, page, saves, save, close };
}

test('the page is served on this computer only, with its settings, and follows each save', async () => {
  const root = folder();
  const saves = [];
  const page = await serveDesignFolder({
    root,
    project: 'catan',
    branch: 'design/harbor-trade',
    main: 'origin/main',
    deployUrl: 'https://deploy.local',
    machine: 'Mac',
    assets: {
      'index.html': Buffer.from('<!doctype html><html><head></head><body></body></html>'),
      'assets/app.js': Buffer.from('console.log(1)'),
    },
    designSystem: () => null,
    onSave: (save) => saves.push(save),
    ports: [0],
    signals: false,
  });
  try {
    assert.match(page.url, /^http:\/\/localhost:\d+$/);
    const home = await get(page.port, '/');
    assert.equal(home.status, 302);
    assert.equal(home.headers.location, '/?project=local&view=canvas');
    const index = await get(page.port, '/?project=local&view=canvas');
    assert.match(
      index.body,
      /<head><script>window\.__DEPLOY_DESIGN_LOCAL__=\{"project":"catan","branch":"design\/harbor-trade","deployUrl":"https:\/\/deploy\.local","machine":"Mac"\}<\/script>/,
    );
    assert.equal((await get(page.port, '/assets/app.js')).body, 'console.log(1)');
    assert.equal((await get(page.port, '/assets/missing.js')).status, 404);
    assert.equal((await get(page.port, '/', 'evil.example')).status, 403);
    // A write from another site open in the same browser is refused before the folder is touched.
    const post = (origin) =>
      new Promise((resolve, reject) =>
        request(
          {
            port: page.port,
            path: '/api/projects/local/design/edit',
            host: '127.0.0.1',
            method: 'POST',
            headers: { host: `localhost:${page.port}`, ...(origin ? { origin } : {}) },
          },
          (res) => (res.resume(), resolve(res.statusCode)),
        )
          .on('error', reject)
          .end('{}'),
      );
    assert.equal(await post('https://evil.example'), 403);
    assert.notEqual(await post(`http://localhost:${page.port}`), 403);
    const design = JSON.parse((await get(page.port, '/api/projects/local/design')).body);
    assert.equal(design.ref, 'design/harbor-trade');

    // A save is a new version for the page, which measures the board, and one line for the terminal.
    const open = watchPage(page.port);
    await new Promise((resolve) => setTimeout(resolve, 200));
    writeFileSync(join(root, 'design/boards/Harbor.html'), '<main data-layer="page">Trade</main>');
    const [first, second] = await open.messages(2);
    open.close();
    assert.notEqual(first.commit, second.commit);
    assert.deepEqual(second.measure, [{ save: '1', file: 'Harbor.html', height: 900 }]);
    assert.equal(
      await measured(page.port, { save: '1', after: { scrolls: false, cut: null }, before: null }),
      204,
    );
    assert.deepEqual(saves, [{ file: 'Harbor.html', problems: [] }]);
  } finally {
    page.stop();
    await page.stopped;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a save measured by the open page prints once, with what leaves the page at 700', async () => {
  const at = await serve({ measureWait: 5000 });
  try {
    const open = watchPage(at.page.port);
    await pause(200);
    const saved = Date.now();
    at.save('<main data-layer="page"><p data-layer="offer">Offer 2 brick</p></main>');
    const [, change] = await open.messages(2);
    const { save } = change.measure[0];
    const cut = { scrolls: true, cut: 'Offer 2 brick' };
    assert.equal(await measured(at.page.port, { save, after: cut, before: null }), 204);
    assert.deepEqual(
      at.saves.map(({ file, problems }) => ({ file, problems })),
      [
        {
          file: 'Harbor.html',
          problems: [
            {
              file: 'Harbor.html',
              short: 'cut off at 700 px',
              detail: '"Offer 2 brick" leaves the page',
            },
          ],
        },
      ],
    );
    assert.ok(at.saves[0].at - saved < 2000, 'printed when the measurement came, not at the wait');
    // The same save measured again prints nothing more.
    assert.equal(await measured(at.page.port, { save, after: cut, before: null }), 410);
    assert.equal(at.saves.length, 1);

    // Only what main's board does not already have: the same cut on main is not this save's.
    at.save('<main data-layer="page"><p data-layer="offer">Offer 2 brick!</p></main>');
    const [, , again] = await open.messages(3);
    assert.equal(
      await measured(at.page.port, { save: again.measure[0].save, after: cut, before: cut }),
      204,
    );
    assert.deepEqual(at.saves[1].problems, []);
    // Sideways scrolling, in the check's words.
    at.save('<main data-layer="page"><p data-layer="offer">Wide</p></main>');
    const [, , , wide] = await open.messages(4);
    await measured(at.page.port, {
      save: wide.measure[0].save,
      after: { scrolls: true, cut: null },
      before: { scrolls: false, cut: null },
    });
    assert.deepEqual(
      at.saves[2].problems.map((problem) => `${problem.short} · ${problem.detail}`),
      ['overflows at 700 px · the page scrolls sideways'],
    );
    open.close();
  } finally {
    await at.close();
  }
});

test('with no page open a save prints at once, unmeasured', async () => {
  const at = await serve({ measureWait: 10_000 });
  try {
    const saved = Date.now();
    at.save('<main data-layer="page">Trade</main>');
    for (let tries = 0; !at.saves.length && tries < 50; tries++) await pause(50);
    assert.deepEqual(
      at.saves.map(({ file, problems }) => ({ file, problems })),
      [{ file: 'Harbor.html', problems: [] }],
    );
    assert.ok(at.saves[0].at - saved < 2000);
  } finally {
    await at.close();
  }
});

test('a measurement later than the wait prints no second line; a phone board is not measured', async () => {
  const at = await serve({ measureWait: 300 });
  try {
    const open = watchPage(at.page.port);
    await pause(200);
    at.save('<main data-layer="page">Trade</main>');
    const [, change] = await open.messages(2);
    await pause(600);
    assert.deepEqual(
      at.saves.map(({ file, problems }) => ({ file, problems })),
      [{ file: 'Harbor.html', problems: [] }],
    );
    const late = {
      save: change.measure[0].save,
      after: { scrolls: true, cut: 'Late' },
      before: null,
    };
    assert.equal(await measured(at.page.port, late), 410);
    assert.equal(at.saves.length, 1);

    writeFileSync(
      join(at.root, 'design/canvas.json'),
      JSON.stringify({
        boards: {
          'Harbor.html': { x: 0, y: 0, w: 1440, h: 900 },
          'Dock.html': { x: 0, y: 1000, w: 390, h: 844 },
        },
      }),
    );
    const [, , canvas] = await open.messages(3);
    assert.deepEqual(canvas.measure, []);
    at.save('<main data-layer="page">Dock</main>', 'Dock.html');
    const [, , , dock] = await open.messages(4);
    assert.deepEqual(dock.measure, []);
    assert.equal(at.saves.at(-1).file, 'Dock.html');
    open.close();
  } finally {
    await at.close();
  }
});
