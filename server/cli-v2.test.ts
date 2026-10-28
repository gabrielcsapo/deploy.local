import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'deploy-v2-cli-'));
const home = join(root, 'account');
const project = join(root, 'home-gym');
mkdirSync(home);
mkdirSync(project);
writeFileSync(join(home, '.deployrc'), JSON.stringify({ username: 'fixture', token: 'stub-only' }));
writeFileSync(join(project, 'deploy.yaml'), 'apiVersion: deploy/v1\n');
const cli = resolve('bin/deploy.js');
const requests: { path: string; method: string; body: any }[] = [];
let inboxStatus = 200;
let waiting = true;
const item = {
  id: 'rollback-1',
  kind: 'rollback',
  title: 'Roll back home-gym to 81be0d2?',
  text: 'The sync worker is failing.',
  from: 'Warden',
  state: 'waiting',
  actions: [{ id: 'rollback', label: 'Roll back', confirm: 'Both apps go back. Continue?' }],
};
const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    const path = request.url || '';
    requests.push({ path, method: request.method || '', body: body ? JSON.parse(body) : null });
    response.setHeader('Content-Type', 'application/json');
    if (path === '/api/v2/inbox?state=waiting') {
      response.statusCode = inboxStatus;
      response.end(JSON.stringify({ items: waiting ? [item] : [] }));
    } else if (path === '/api/v2/inbox/rollback-1/answer') {
      response.end(
        JSON.stringify({
          ...item,
          state: 'answered',
          answer: { ...JSON.parse(body), by: 'fixture' },
        }),
      );
    } else if (path === '/api/nodes') {
      response.end(
        JSON.stringify({
          nodes: [
            { id: 'ser', name: 'SER', kind: 'coordinator', status: 'online' },
            { id: 'bazzite', name: 'bazzite', kind: 'worker', status: 'online' },
          ],
        }),
      );
    } else if (path === '/api/deployments') {
      response.end(
        JSON.stringify([
          { name: 'home-gym sync', nodeId: 'ser', status: 'failed' },
          { name: 'home-gym', nodeId: 'ser', status: 'running' },
          { name: 'Vaultwarden', nodeId: 'bazzite', status: 'healthy' },
        ]),
      );
    } else if (path.endsWith('/build-logs')) {
      response.end(JSON.stringify({ logs: [{ output: 'build output\n' }] }));
    } else if (path.endsWith('/logs')) {
      response.end('runtime output\n');
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'Not found' }));
    }
  });
});
let port = 5180;
before(async () => {
  for (; port <= 5199; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      break;
    } catch (error: any) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  assert.ok(port <= 5199, 'A test port in 5180–5199 must be free');
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});
function run(args: string[], cwd = root) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args, '-u', `http://127.0.0.1:${port}`], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        DEPLOY_AUTH_JSON: '',
        DEPLOY_AUTH_FILE: '',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('help groups public commands and keeps old commands in advanced help', async () => {
  const result = await run(['--help']);
  assert.equal(result.code, 0, result.stderr);
  for (const heading of ['Ship', 'Watch', 'Decide', 'Agents', 'Apps and computers', 'Account'])
    assert.match(result.stdout, new RegExp(`^${heading}`, 'm'));
  assert.doesNotMatch(result.stdout, /-a,|deploy publish|deploy recovery|deploy component/);
  const advanced = await run(['help', 'advanced']);
  assert.match(advanced.stdout, /deploy publish/);
  assert.match(advanced.stdout, /deploy recovery/);
  assert.match(advanced.stdout, /deploy component/);
});

test('positional apps, hidden aliases and project folder defaults select the same app', async () => {
  for (const args of [
    ['logs', 'home-gym'],
    ['logs', '-a', 'home-gym'],
    ['logs', '--app', 'home-gym'],
    ['logs'],
  ]) {
    const result = await run(args, project);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'runtime output\n');
    assert.equal(requests.at(-1)?.path, '/api/deployments/home-gym/logs');
  }
  const conflict = await run(['logs', 'other', '-a', 'home-gym']);
  assert.equal(conflict.code, 2);
  const missing = await run(['logs']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /Which app\?.*not a project/);
  assert.match(missing.stderr, /deploy logs home-gym/);
});

test('status groups computers, preserves unknown health, and exits 3 for waiting decisions', async () => {
  const result = await run(['status']);
  assert.equal(result.code, 3, result.stderr);
  assert.match(result.stdout, /SER.*online/);
  assert.match(result.stdout, /home-gym sync  Failing/);
  assert.match(result.stdout, /home-gym  Running  Health checks unavailable/);
  assert.match(result.stdout, /bazzite.*online/);
  assert.match(result.stdout, /! 1 waiting on you.*deploy inbox/);
  assert.ok(!result.stdout.includes(String.fromCharCode(27)));
  assert.ok(!result.stdout.includes('\r'));
  const json = await run(['status', '--json']);
  assert.equal(json.code, 3);
  const status = JSON.parse(json.stdout);
  assert.deepEqual(
    status.failing.map((app: any) => app.name),
    ['home-gym sync'],
  );
  assert.equal(status.computers.length, 2);
  assert.equal(status.waiting[0].id, item.id);
  waiting = false;
  assert.equal((await run(['status'])).code, 0);
  waiting = true;
});

test('inbox detects only 404 as unsupported; old status still works', async () => {
  inboxStatus = 404;
  const result = await run(['inbox']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /This deploy.local doesn't support the inbox yet/);
  const status = await run(['status', '--json']);
  assert.equal(status.code, 0);
  assert.equal(JSON.parse(status.stdout).inboxSupported, false);
  inboxStatus = 500;
  assert.equal((await run(['status'])).code, 1);
  assert.equal((await run(['inbox'])).code, 1);
  inboxStatus = 200;
});

test('inbox lists structured items and posts only an explicit action with cli provenance', async () => {
  const listed = await run(['inbox', '--json']);
  assert.deepEqual(JSON.parse(listed.stdout), { items: [item] });
  const before = requests.filter((request) => request.method === 'POST').length;
  const refused = await run(['inbox', item.id, 'rollback']);
  assert.equal(refused.code, 2);
  assert.equal(requests.filter((request) => request.method === 'POST').length, before);
  for (const yes of ['--yes', '-y']) {
    const answer = await run(['inbox', item.id, 'rollback', yes, '--json']);
    assert.equal(answer.code, 0, answer.stderr);
    assert.equal(JSON.parse(answer.stdout).answer.on, 'cli');
    assert.deepEqual(requests.at(-1)?.body, { actionId: 'rollback', on: 'cli' });
  }
});

test('errors suggest the next command, use exit 2 for usage and serialize JSON errors', async () => {
  const result = await run(['stauts']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown command "stauts"\. Did you mean status\?/);
  assert.match(result.stderr, /Next: deploy status/);
  const json = await run(['stauts', '--json']);
  assert.equal(JSON.parse(json.stderr).exitCode, 2);
  assert.equal(json.stdout, '');
});

test('logs --build uses stored build output and logs --json emits JSON records', async () => {
  const build = await run(['logs', 'home-gym', '--build', '--json']);
  assert.equal(JSON.parse(build.stdout).build.output, 'build output\n');
  const logs = await run(['logs', 'home-gym', '--json']);
  assert.deepEqual(JSON.parse(logs.stdout), { app: 'home-gym', output: 'runtime output\n' });
});
