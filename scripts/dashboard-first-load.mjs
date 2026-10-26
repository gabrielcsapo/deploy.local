// Reproducible first-load audit against an isolated production build and demo database.
// Run after pnpm build: node --import tsx scripts/dashboard-first-load.mjs --verify [--throttle] [--runs=3]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { seedVisualAuditDemo } from './visual-audit-demo.mjs';

const directory = mkdtempSync(join(tmpdir(), 'dashboard-first-load-'));
let server, browser;
try {
  const auth = await seedVisualAuditDemo(directory);
  // The shared visual fixture also creates retired portable sites. This disposable
  // Home-only audit keeps its apps/computers/telemetry and omits those legacy targets.
  const store = await import('../server/store.ts');
  const demo = store.getSqlite();
  demo.pragma('foreign_keys = OFF');
  demo.exec(
    "DELETE FROM app_replicas WHERE site_id IN (SELECT id FROM sites WHERE kind <> 'home'); DELETE FROM sites WHERE kind <> 'home'",
  );
  demo.pragma('foreign_keys = ON');
  store._resetDb();
  const { save, db } = await import('../server/workspace/store.ts');
  const { createAttachment } = await import('../server/workspace/attachments.ts');
  // The visual demo seeds apps and computers; add a repeatable recent-task inventory.
  const tasks = Array.from({ length: 12 }, (_, i) => ({
    id: `first-load-${i}`,
    title: `First load task ${i}`,
    projectId: null,
    status: i < 4 ? 'running' : 'ready',
    workerId: 'audit-offline',
    revision: 0,
    workspacePath: directory,
    createdAt: new Date(1792700000000 + i * 1000).toISOString(),
    updatedAt: new Date(1792700000000 + i * 1000).toISOString(),
  }));
  for (const task of tasks) {
    save('task', auth.username, task);
    save('remote-diff', auth.username, { id: task.id, files: [], checks: [] });
    for (let i = 0; i < 12; i++) {
      const messageId = `${task.id}-message-${i}`;
      save('message', auth.username, {
        id: messageId,
        taskId: task.id,
        role: 'assistant',
        content: `Demo result ${i}\n\n${'A completed step. '.repeat(100)}`,
        createdAt: task.createdAt,
      });
      createAttachment(
        auth.username,
        task.id,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6XcAAAAASUVORK5CYII=',
          'base64',
        ),
        { operationId: messageId, messageId, name: `Result ${i}.png`, kind: 'image' },
      );
    }
  }
  db.close();
  const httpPort = await port(),
    httpsPort = await port();
  let output = '';
  server = spawn(process.execPath, ['dist/server.js'], {
    env: {
      ...process.env,
      DEPLOY_DATA_DIR: directory,
      DEPLOY_MDNS_ADDRESS: '127.0.0.1',
      PORT: String(httpPort),
      HTTPS_PORT: String(httpsPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => {
    output = (output + chunk).slice(-12000);
  });
  server.stderr.on('data', (chunk) => {
    output = (output + chunk).slice(-12000);
  });
  const deadline = Date.now() + 90000;
  while (!output.includes('server running on')) {
    if (server.exitCode !== null || Date.now() > deadline) throw new Error(output);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  browser = await chromium.launch({ headless: true });
  const results = [];
  const runs = Number(process.argv.find((arg) => arg.startsWith('--runs='))?.split('=')[1] || 1);
  for (let run = 1; run <= runs; run++) {
    for (const width of [390, 1440]) {
      for (const path of ['/dashboard/computers', '/dashboard']) {
        const context = await browser.newContext({
          viewport: { width, height: 844 },
          ignoreHTTPSErrors: true,
          reducedMotion: 'reduce',
        });
        await context.addInitScript(({ username, token }) => {
          localStorage.setItem('deploy-sh-auth', JSON.stringify({ username, token }));
          localStorage.setItem(`workspace:${username}:selected-task`, 'first-load-0');
        }, auth);
        const page = await context.newPage();
        if (process.argv.includes('--throttle')) {
          const network = await context.newCDPSession(page);
          await network.send('Network.enable');
          await network.send('Network.emulateNetworkConditions', {
            offline: false,
            latency: 100,
            downloadThroughput: 200000,
            uploadThroughput: 93750,
            connectionType: 'cellular3g',
          });
        }
        const requests = [],
          responses = [],
          errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('request', (request) => {
          if (request.url().includes('/api/')) requests.push(request.url());
        });
        page.on('response', (response) => {
          if (response.url().includes('/api/'))
            responses.push({
              url: response.url(),
              status: response.status(),
              at: performance.now(),
            });
        });
        const start = performance.now();
        await page.goto(`https://127.0.0.1:${httpsPort}${path}`);
        const ownData = path.endsWith('computers')
          ? '/api/computers'
          : '/api/workspace/tasks/first-load-0';
        await page.waitForFunction(() => document.querySelector('.project-workspace'));
        while (!responses.some((r) => new URL(r.url).pathname === ownData)) {
          if (performance.now() - start > 30000) throw new Error(`No page data for ${path}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(responses.find((r) => new URL(r.url).pathname === ownData).status, 200);
        await page.waitForTimeout(4000);
        const details = requests.filter((url) => /\/tasks\/[^/?]+$/.test(url));
        const diffs = requests.filter((url) => /\/diff(?:\?|$)/.test(url));
        const thumbnails = requests.filter((url) => /\/thumbnail$/.test(url));
        const result = {
          run,
          width,
          path,
          taskDetails: details.length,
          uniqueTasks: new Set(details).size,
          diffs: diffs.length,
          thumbnails: thumbnails.length,
          pageDataMs: Math.round(
            responses.find((r) => new URL(r.url).pathname === ownData).at - start,
          ),
          taskRequestsBeforePageData: requests
            .slice(
              0,
              requests.findIndex((url) => new URL(url).pathname === ownData),
            )
            .filter((url) => /\/tasks\/[^/]+(?:\/diff)?$/.test(new URL(url).pathname)).length,
        };
        results.push(result);
        assert.deepEqual(errors, []);
        if (process.argv.includes('--verify')) {
          if (path.endsWith('computers')) {
            assert.equal(details.length, 0);
            assert.equal(diffs.length, 0);
            assert.equal(thumbnails.length, 0);
          } else {
            assert.equal(result.uniqueTasks, 4);
            assert.ok(diffs.every((url) => url.includes('/first-load-0/diff')));
            assert.ok(thumbnails.length < 12, 'offscreen images stay lazy');
          }
          assert.equal(result.taskRequestsBeforePageData, 0);
        }
        await context.close();
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        observationMs: 4000,
        tasks: 12,
        imagesPerTask: 12,
        network: process.argv.includes('--throttle')
          ? '100ms latency, 1.6Mbps down'
          : 'unthrottled',
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
  }
  rmSync(directory, { recursive: true, force: true });
}

async function port() {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const value = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return value;
}
