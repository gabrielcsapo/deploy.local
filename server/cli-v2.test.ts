import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
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
let buildSuccess = true;
let buildPending = false;
let releasesSupported = true;
const shipProject = join(root, 'ship', 'home-gym');
mkdirSync(shipProject, { recursive: true });
writeFileSync(join(shipProject, 'Dockerfile'), 'FROM scratch\n');
const release = {
  id: '9c3e1fa',
  state: 'live',
  projectId: 'home-gym',
  apps: [{ appId: 'home-gym', to: '9c3e1fa' }],
  migrations: [{ id: '0042', title: 'Rename workout column', reversible: true }],
};
function evidence(
  name: string,
  args: string,
  result: { code: number | null; stdout: string; stderr: string },
  append = false,
) {
  const directory = process.env.DEPLOY_CLI_EVIDENCE;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${name}.txt`),
    `$ deploy ${args}\n${result.stdout}${result.stderr}[exit ${result.code}]\n`,
    { flag: append ? 'a' : 'w' },
  );
}

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
    requests.push({
      path,
      method: request.method || '',
      body: body ? (body.startsWith('----') ? body : JSON.parse(body)) : null,
    });
    response.setHeader('Content-Type', 'application/json');
    if (path === '/api/deploy-admission' || path.startsWith('/api/deploy-admission/')) {
      response.end(JSON.stringify({ placementReady: true }));
    } else if (path === '/api/upload') {
      response.end(JSON.stringify({ accepted: true, name: 'home-gym', buildLogId: 42 }));
    } else if (path === '/api/v2/projects/home-gym/releases') {
      response.statusCode = releasesSupported ? 200 : 404;
      response.end(
        JSON.stringify({
          releases: [
            release,
            {
              ...release,
              id: '81be0d2',
              state: 'superseded',
              apps: [{ appId: 'home-gym', to: '81be0d2' }],
              migrations: [],
            },
          ],
        }),
      );
    } else if (path === '/api/v2/projects/home-gym/rollback') {
      response.end(
        JSON.stringify({
          id: 'rollback-42',
          from: '9c3e1fa',
          to: '81be0d2',
          steps: ['prepare', 'verify', 'activate', 'watch'].map((name) => ({
            name,
            state: 'done',
          })),
        }),
      );
    } else if (path === '/api/workspace/state') {
      response.end(
        JSON.stringify({
          tasks: [{ id: 'task-1', title: 'Fix sync worker', status: 'running' }],
          workers: [{ id: 'worker-bazzite', name: 'bazzite' }],
        }),
      );
    } else if (path === '/api/workspace/tasks') {
      response.end(
        JSON.stringify({ id: 'task-2', title: JSON.parse(body).title, status: 'preparing' }),
      );
    } else if (path === '/api/v2/inbox?state=waiting') {
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
          { name: 'Vaultwarden', activeNodeId: 'bazzite', status: 'healthy' },
        ]),
      );
    } else if (path.endsWith('/build-logs')) {
      response.end(
        JSON.stringify({
          logs: [
            {
              id: 42,
              status: buildPending ? 'building' : buildSuccess ? 'complete' : 'failed',
              success: buildPending ? null : buildSuccess,
              output: buildSuccess
                ? 'build output\n'
                : 'install dependencies\nverbose build noise\nError: column "started" does not exist\n    at readWorkouts (src/sync/workouts.ts:41)\n',
            },
          ],
        }),
      );
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

test('register directs people to setup or an admin without anonymous registration', async () => {
  const count = requests.length;
  const result = await run(['register']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`http://127.0.0.1:${port}/setup`));
  assert.match(result.stdout, /setup code from the installer/);
  assert.match(result.stdout, /ask an admin/);
  assert.match(result.stdout, /deploy login/);
  assert.equal(requests.length, count);
});

test('help groups public commands and keeps old commands in advanced help', async () => {
  const result = await run(['--help']);
  evidence('CliHelp', '--help', result);
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
  evidence('CliStatus', 'status', result);
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
  evidence('CliErrors', 'stauts', result);
  const missing = await run(['logs']);
  evidence('CliErrors', 'logs', missing, true);
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

test('deploy follows its build receipt, hides build chatter and reports honest release steps', async () => {
  const result = await run(['deploy'], shipProject);
  evidence('CliDeploy', '', result);
  assert.equal(result.code, 0, result.stderr);
  for (const name of ['Prepare', 'Verify', 'Activate', 'Watch'])
    assert.ok(result.stdout.includes(name));
  assert.match(result.stdout, /Separate verification is not reported/);
  assert.match(result.stdout, /Released home-gym/);
  assert.doesNotMatch(result.stdout, /build output|Deployment accepted|Uploading/);
  const json = await run(['deploy', '--json'], shipProject);
  const data = JSON.parse(json.stdout);
  assert.equal(data.state, 'live');
  assert.deepEqual(
    data.steps.map((step: any) => step.name),
    ['prepare', 'verify', 'activate', 'watch'],
  );
  assert.equal(data.buildLogId, 42);
  buildSuccess = false;
  const failure = await run(['deploy'], shipProject);
  evidence('CliDeploy', '', failure, true);
  assert.equal(failure.code, 1, failure.stderr);
  assert.match(failure.stdout, /column "started" does not exist/);
  assert.doesNotMatch(failure.stdout, /verbose build noise|install dependencies|Nothing changed/);
  assert.match(failure.stdout, /Next: deploy logs --build/);
  const failedJson = await run(['deploy', '--json'], shipProject);
  assert.equal(JSON.parse(failedJson.stdout).state, 'failed');
  assert.equal(failedJson.code, 1);
  buildSuccess = true;
  buildPending = true;
  const pending = await run(['deploy', '--json', '--wait-timeout', '0'], shipProject);
  assert.equal(pending.code, 1);
  assert.equal(JSON.parse(pending.stdout).state, 'running');
  buildPending = false;
});

test('rollback previews all changes, requires confirmation and uses only the project route', async () => {
  const before = requests.filter((request) => request.method === 'POST').length;
  const refused = await run(['rollback', 'home-gym']);
  assert.equal(refused.code, 2, refused.stderr);
  assert.match(refused.stdout, /9c3e1fa → 81be0d2/);
  assert.match(refused.stdout, /Rename workout column: undo migration/);
  assert.equal(requests.filter((request) => request.method === 'POST').length, before);
  const result = await run(['rollback', 'home-gym', '-y', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).state, 'rolled-back');
  assert.deepEqual(requests.at(-1), {
    path: '/api/v2/projects/home-gym/rollback',
    method: 'POST',
    body: { to: '81be0d2', from: '9c3e1fa' },
  });
  release.migrations[0].reversible = false;
  const destructive = await run(['rollback', 'home-gym', '-y']);
  assert.equal(destructive.code, 2);
  assert.match(destructive.stderr, /requires a data restore/);
  release.migrations[0].reversible = true;
  releasesSupported = false;
  assert.equal((await run(['rollback', 'home-gym', '-y'])).code, 2);
  releasesSupported = true;
});

test('other data commands expose JSON and task aliases reach existing workspace APIs', async () => {
  for (const args of [
    ['files'],
    ['whoami'],
    ['version'],
    ['list'],
    ['computers'],
    ['tasks'],
    ['releases', 'home-gym'],
    ['open', 'home-gym'],
  ]) {
    const result = await run([...args, '--json']);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(JSON.parse(result.stdout));
  }
  const task = await run([
    'task',
    'Fix sync worker',
    '--on',
    'bazzite',
    '--agent',
    'scout',
    '--json',
  ]);
  assert.equal(task.code, 0, task.stderr);
  assert.equal(JSON.parse(task.stdout).title, 'Fix sync worker');
  assert.equal(requests.at(-1)?.body.workerId, 'worker-bazzite');
  const schema = await run(['schema', '--json']);
  for (const line of schema.stdout.trim().split('\n'))
    assert.equal(typeof JSON.parse(line).message, 'string');
});

test('the CLI bundle includes its v2 helpers without external runtime modules', async () => {
  const esbuild = createRequire(import.meta.resolve('vite'))('esbuild');
  const bundle = join(root, 'deploy.mjs');
  await esbuild.build({
    entryPoints: [cli],
    bundle: true,
    platform: 'node',
    // Same as build-cli.mjs: browser control uses a locally installed Playwright runtime.
    external: ['playwright'],
    format: 'esm',
    outfile: bundle,
  });
  // Match build-cli.mjs's SEA bootstrap conversion, including dynamic CJS requires.
  let source = readFileSync(bundle, 'utf8').replace(/^#!.*\n/, '');
  source = source.replace(
    /^import\s+(\{[^}]+\})\s+from\s+"(node:[^"]+)";?$/gm,
    (_, bindings, module) =>
      `var ${bindings.replace(/\b(\w+)\s+as\s+(\w+)\b/g, '$1: $2')} = require("${module}");`,
  );
  source = source.replace(
    /^import\s+(\w+)\s+from\s+"(node:[^"]+)";?$/gm,
    'var $1 = require("$2");',
  );
  source = source
    .replace(/import\.meta\.dirname/g, '__dirname')
    .replace(/import\.meta\.url/g, '"file://" + __filename');
  source = source.replace(/^export\s+\{[^}]*\};?$/gm, '');
  const bootstrap = join(root, 'deploy.cjs');
  writeFileSync(
    bootstrap,
    `;(async () => {\n${source}\n})().catch((error) => { console.error(error); process.exitCode = 1; });`,
  );
  const result = spawnSync(process.execPath, [bootstrap, '--help'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Apps and computers/);
  assert.match(result.stdout, /deploy help advanced/);
});
