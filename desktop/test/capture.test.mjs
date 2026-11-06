import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { verifyPreloads } from '../scripts/preload-check.mjs';
import { fixtureRuntime } from '../scripts/fixture-runtime.mjs';
import { startFixture, preview } from '../../docs/evidence/v2/13-desktop-2/fixture-server.mjs';
import { CoordinatorClient } from '../src/client.mjs';

test('packaged preload audit rejects extra capabilities, nested methods and shell globals', async () => {
  const remote = await readFile(new URL('../src/preload.cjs', import.meta.url), 'utf8');
  // Exercise the packaged form without requiring a prior desktop build on fresh checkouts.
  const { build } = createRequire(import.meta.resolve('vite'))('esbuild');
  const bundled = await build({
    entryPoints: [new URL('../src/shell-preload.mjs', import.meta.url).pathname],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    write: false,
  });
  const local = bundled.outputFiles[0].text;
  await verifyPreloads(remote, local);
  await assert.rejects(
    verifyPreloads(remote.replace('const api = {', 'const api = { exec: () => {},'), local),
  );
  await assert.rejects(
    verifyPreloads(remote.replace('worker: {', 'worker: { enroll: () => {},'), local),
  );
  await assert.rejects(
    verifyPreloads(
      remote,
      `${local}\nrequire('electron').contextBridge.exposeInMainWorld('extra', {});`,
    ),
  );
  await assert.rejects(verifyPreloads(remote, `${local}\nwindow.extra = {};`));
});

test('fixture runtime rejects real coordinators, mDNS and persistent profiles; cannot enroll', async () => {
  const previous = { ...process.env };
  const directory = await mkdtemp(join(tmpdir(), 'deploy-desktop-capture-'));
  try {
    process.env.DEPLOY_COORDINATOR_URL = 'https://deploy.local';
    process.env.DEPLOY_DESKTOP_DISABLE_MDNS = '1';
    process.env.DEPLOY_DESKTOP_DATA_DIR = directory;
    assert.throws(fixtureRuntime, /loopback/);
    process.env.DEPLOY_COORDINATOR_URL = 'http://127.0.0.1:5184';
    process.env.DEPLOY_DESKTOP_DISABLE_MDNS = '0';
    assert.throws(fixtureRuntime, /disabled mDNS/);
    process.env.DEPLOY_DESKTOP_DISABLE_MDNS = '1';
    process.env.DEPLOY_DESKTOP_DATA_DIR = process.cwd();
    assert.throws(fixtureRuntime, /temporary/);
    process.env.DEPLOY_DESKTOP_DATA_DIR = directory;
    process.env.DEPLOY_DESKTOP_FIXTURE_PLATFORM = 'linux';
    const fixture = fixtureRuntime();
    assert.equal(fixture.state.name, 'bazzite');
    assert.equal(fixture.worker.status().screenSupported, false);
    await assert.rejects(fixture.worker.configure(), /never enrolls/);
  } finally {
    for (const key of [
      'DEPLOY_COORDINATOR_URL',
      'DEPLOY_DESKTOP_DISABLE_MDNS',
      'DEPLOY_DESKTOP_DATA_DIR',
      'DEPLOY_DESKTOP_FIXTURE_PLATFORM',
    ]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
});

// The served shell links this generated file, which a fresh checkout doesn't have until a build.
await copyFile(
  new URL('../../app/design-tokens.css', import.meta.url),
  new URL('../assets/design-tokens.css', import.meta.url),
);

test('capture coordinator serves real v2 envelopes, admission and offline errors with no enrollment route', async () => {
  const fixture = await startFixture();
  const client = new CoordinatorClient('http://127.0.0.1:5184');
  try {
    await assert.rejects(client.inbox(), /Sign in/);
    await client.login('fixture-owner', 'fixture-password');
    assert.equal((await client.inbox()).items.length, 3);
    assert.equal((await client.live()).computers.flatMap((entry) => entry.apps).length, 7);
    assert.deepEqual(await client.events(4), { events: [], cursor: 4 });
    const result = await client.takeNewTasks('desktop-fixture', false);
    assert.equal(result.computer.roles.includes('take-tasks'), false);
    assert.equal(result.computer.doing.length, 1);
    await assert.rejects(
      client.request('/api/workspace/workers/enroll', { method: 'POST' }),
      /unavailable/,
    );
    fixture.state.offline = true;
    await assert.rejects(client.live(), /offline/);
    for (const board of ['Setup', 'SetupLinux', 'Permissions', 'Tray', 'Offline', 'Notification']) {
      const html = await preview(board);
      assert.ok(html.includes('--ds-canvas'));
      assert.ok(html.includes('data:font/woff2;base64,'));
      assert.equal(html.includes('https://deploy.local'), false);
    }
  } finally {
    await fixture.close();
  }
});
