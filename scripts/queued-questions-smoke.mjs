// Run after pnpm build: node --import tsx scripts/queued-questions-smoke.mjs
// Exercises the real web client and API against a disposable coordinator; no agent runs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { seedVisualAuditDemo } from './visual-audit-demo.mjs';

const directory = mkdtempSync(join(tmpdir(), 'queued-questions-smoke-'));
const output = 'output/queued-questions';
mkdirSync(output, { recursive: true });
let server, browser, heartbeat;
try {
  const auth = await seedVisualAuditDemo(directory);
  const { save, get, db } = await import('../server/workspace/store.ts');
  const owner = auth.username;
  const { coordinationTools } = await import('../server/workspace/coordination-tools.ts');
  const workers = ['bazzite', 'MacBook Pro'].map((name, i) => ({
    id: `smoke-${i}`,
    name,
    platform: i ? 'darwin' : 'linux',
    architecture: 'arm64',
    build: { version: '1.0.0' },
    agentTools: coordinationTools.map((tool) => tool.name),
    capabilities: ['codex'],
    modelOptions: [],
    connections: [],
  }));
  const refreshWorkers = () => {
    for (const worker of workers)
      save('worker', owner, { ...worker, heartbeat: new Date().toISOString() });
  };
  refreshWorkers();
  heartbeat = setInterval(refreshWorkers, 2000);
  const seed = () => {
    db.prepare(
      "DELETE FROM records WHERE owner=? AND kind='message' AND json_extract(data,'$.taskId')='question'",
    ).run(owner);
    for (const [id, title, status] of [
      ['busy', 'Build bricks', 'running'],
      ['first', 'Queued first task', 'queued'],
      ['second', 'Queued second task', 'queued'],
      ['question', 'Choose a label', 'succeeded'],
    ]) {
      const createdAt = new Date().toISOString();
      save('task', owner, {
        id,
        title,
        status: status === 'succeeded' ? 'review' : 'running',
        projectId: null,
        workerId: 'smoke-0',
        workspaceStatus: 'ready',
        revision: 1,
        workspacePath: directory,
        baseRevision: '',
        createdAt,
        updatedAt: createdAt,
      });
      save('run', owner, {
        id,
        taskId: id,
        status,
        workerId: 'smoke-0',
        adapter: 'codex',
        model: '',
        effort: '',
        createdAt,
        updatedAt: createdAt,
      });
    }
    save('question', owner, {
      id: 'pending-question',
      taskId: 'question',
      runId: 'question',
      question: 'Which label should we use?',
      options: ['Blue', 'Green'],
      status: 'pending',
      answer: null,
      expiresAt: null,
      createdAt: new Date().toISOString(),
    });
  };
  const httpPort = await freePort(),
    httpsPort = await freePort();
  let log = '';
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
  for (const stream of [server.stdout, server.stderr])
    stream.on('data', (chunk) => {
      log = (log + chunk).slice(-12000);
    });
  const deadline = Date.now() + 90000;
  while (!log.includes('server running on')) {
    if (server.exitCode !== null || Date.now() > deadline) throw new Error(log);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // The browser and isolated test coordinator run on the same machine.
  const origin = `https://127.0.0.1:${httpsPort}`;
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390]) {
    seed();
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      reducedMotion: 'reduce',
      // Trust only the disposable coordinator within this isolated browser context.
      ignoreHTTPSErrors: true,
    });
    await context.addInitScript(({ username, token }) => {
      localStorage.setItem('deploy-sh-auth', JSON.stringify({ username, token }));
    }, auth);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/dashboard?task=second`);
    if (width < 640)
      await page.locator('.task-tree-task[href*="task=second"]:visible').first().click();
    const queue = page.locator('.pw-compose-area .pw-queued');
    await queue
      .getByText('Waiting for bazzite — busy with Build bricks', { exact: false })
      .waitFor();
    assert.match(await queue.innerText(), /Position 2 of 2/);
    await page.screenshot({ path: `${output}/queue-${width}.png` });
    await page
      .locator('.ui-status-label:visible', { hasText: /^Queued$/ })
      .first()
      .waitFor();
    await page.screenshot({ path: `${output}/queue-${width}.png` });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    const move = page.getByRole('button', { name: 'Move to MacBook Pro', exact: true });
    await move.focus();
    await page.keyboard.press('Enter');
    await queue
      .getByText('Waiting for MacBook Pro to pick up this run', { exact: false })
      .waitFor();
    assert.equal(get('run', owner, 'second').workerId, 'smoke-1');
    await page.goto(`${origin}/dashboard?task=question`);
    if (width < 640)
      await page.locator('.task-tree-task[href*="task=question"]:visible').first().click();
    const question = page.getByRole('form', { name: 'Agent question' });
    await question.waitFor();
    if (width >= 640)
      await page
        .locator('.ui-status-label:visible', { hasText: 'Waiting for your answer' })
        .first()
        .waitFor();
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    await page.screenshot({ path: `${output}/question-${width}.png` });
    await question.locator('input').fill('Green');
    await question.getByRole('button', { name: 'Continue', exact: true }).click();
    await question.waitFor({ state: 'hidden' });
    const answered = get('question', owner, 'pending-question');
    assert.equal(answered.status, 'answered');
    assert.match(get('run', owner, answered.followUpRunId).prompt, /Owner answer: Green/);
    await page.evaluate(
      (username) =>
        localStorage.removeItem(`workspace:${encodeURIComponent(username)}:selected-task`),
      auth.username,
    );
    await page.goto(`${origin}/dashboard`);
    if (width < 640) await page.locator('.task-tree-compose:visible').click();
    await page.getByText('bazzite is busy with 1 task — this will wait', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Message', exact: true }).focus();
    assert.equal(
      await page
        .getByRole('textbox', { name: 'Message', exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      `Verified queue reason/position, move, persistent question, answer resumption and busy composer at ${width}px`,
    );
    // Keep iterations independent of the follow-up started by the previous answer.
    db.prepare(
      "DELETE FROM records WHERE owner=? AND kind='run' AND id NOT IN ('busy','first','second','question')",
    ).run(owner);
  }
} finally {
  clearInterval(heartbeat);
  await browser?.close();
  if (server) {
    server.kill('SIGTERM');
    await new Promise((resolve) =>
      server.exitCode !== null ? resolve() : server.once('exit', resolve),
    );
  }
  rmSync(directory, { recursive: true, force: true });
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
