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

    // A save is a new version for the page, and one line for the terminal.
    const versions = [];
    let stream;
    const changed = new Promise((resolve) => {
      stream = request(
        {
          port: page.port,
          path: '/api/design-local/events',
          host: '127.0.0.1',
          headers: { host: `localhost:${page.port}` },
        },
        (res) =>
          res.on('data', (chunk) => {
            for (const line of String(chunk).split('\n'))
              if (line.startsWith('data: ')) versions.push(JSON.parse(line.slice(6)).commit);
            if (versions.length === 2) resolve();
          }),
      );
      stream.end();
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    writeFileSync(join(root, 'design/boards/Harbor.html'), '<main data-layer="page">Trade</main>');
    await changed;
    stream.destroy();
    assert.notEqual(versions[0], versions[1]);
    assert.deepEqual(saves, [{ file: 'Harbor.html', problems: [] }]);
  } finally {
    page.stop();
    await page.stopped;
    rmSync(root, { recursive: true, force: true });
  }
});
