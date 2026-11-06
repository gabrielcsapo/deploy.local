import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { prepareAgentInstall, agentEnvironment, agentShellEnvironment } from './agent-packages.ts';
import { agentLaunch } from './agent-launch.ts';
const root = await mkdtemp(join(tmpdir(), 'agent-packages-'));
process.env.DEPLOY_DATA_DIR = root;
const { save, get, db } = await import('./store.ts');
await import('../packages/hooks.ts');
const { registerUser, _resetDb } = await import('../store.ts');
registerUser('owner', 'test-password-long');
const key = 'dlp_' + 'r'.repeat(43);
after(async () => {
  _resetDb();
  db.close();
  await rm(root, { recursive: true, force: true });
});
const pause = () => new Promise((done) => setTimeout(done, 30));
async function until(read: () => any, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await pause();
  }
  throw Error('Timed out');
}

test('run config is fenced by worker, generation, process and project policy', async () => {
  const { jobCommand } = await import('./coordination.ts');
  save('worker', 'owner', { id: 'worker', instanceId: 'instance' });
  save('task', 'owner', { id: 'task', projectId: 'project' });
  save('run', 'owner', {
    id: 'run',
    taskId: 'task',
    workerId: 'worker',
    status: 'starting',
    generation: 'generation',
    assignedInstanceId: 'instance',
  });
  const body = { runId: 'run', generation: 'generation', instanceId: 'instance' };
  for (const changes of [{ generation: 'stale' }, { instanceId: 'stale' }, { runId: 'missing' }])
    assert.throws(() => jobCommand('owner', 'worker', 'packages', { ...body, ...changes }));
  assert.throws(() => jobCommand('owner', 'other-worker', 'packages', body));
  save('v2-project-policy', 'owner', { id: 'project', installThroughDeploy: false });
  assert.equal((await jobCommand('owner', 'worker', 'packages', body)).key, '');
  save('v2-project-policy', 'owner', { id: 'project', installThroughDeploy: true });
  const config = await jobCommand('owner', 'worker', 'packages', body);
  assert.match(config.key, /^dlp_/);
  assert.equal(
    config.address,
    undefined,
    'remote worker resolves coordinator, not its own host gateway',
  );
  save('run', 'owner', { ...get('run', 'owner', 'run'), status: 'succeeded' });
  assert.throws(() => jobCommand('owner', 'worker', 'packages', body));
});

test('agent runtime and native shell environment keep install config without enrollment or provider secrets in shells', async () => {
  const source = {
    PATH: '/bin',
    NPM_CONFIG_USERCONFIG: '/private/npmrc',
    YARN_NPM_AUTH_TOKEN: key,
    DEPLOY_WORKER_TOKEN: 'worker',
    DEPLOY_WORKSPACE_TOKEN: 'workspace',
    DEPLOY_AGENT_TOKEN: 'agent',
    OPENAI_API_KEY: 'provider',
  };
  const runtime: NodeJS.ProcessEnv = {
    ...agentEnvironment(source),
    NPM_CONFIG_USERCONFIG: source.NPM_CONFIG_USERCONFIG,
    YARN_NPM_AUTH_TOKEN: key,
  };
  assert.equal(runtime.DEPLOY_WORKER_TOKEN, undefined);
  assert.equal(runtime.DEPLOY_WORKSPACE_TOKEN, undefined);
  assert.equal(runtime.OPENAI_API_KEY, 'provider');
  assert.deepEqual(agentShellEnvironment(runtime), {
    PATH: '/bin',
    NPM_CONFIG_USERCONFIG: '/private/npmrc',
    YARN_NPM_AUTH_TOKEN: key,
  });
  const launch = agentLaunch({ adapter: 'codex' }, runtime);
  const include = launch.args.find((arg) =>
    arg.startsWith('shell_environment_policy.include_only='),
  )!;
  const names = JSON.parse(include.slice(include.indexOf('=') + 1));
  assert.ok(names.includes('NPM_CONFIG_USERCONFIG'));
  assert.ok(names.includes('YARN_NPM_AUTH_TOKEN'));
  assert.ok(!names.includes('DEPLOY_WORKER_TOKEN'));
  assert.ok(!names.includes('DEPLOY_AGENT_TOKEN'));
  assert.ok(!launch.args.join(' ').includes(key));
  const old = await prepareAgentInstall(
    async () => {
      throw Error('404 old coordinator');
    },
    { cwd: root, root },
  );
  assert.deepEqual(old.env, {});
  assert.equal(
    agentEnvironment(source, old.env).NPM_CONFIG_USERCONFIG,
    source.NPM_CONFIG_USERCONFIG,
    'older coordinators retain native agent user configuration',
  );
  assert.equal(
    agentEnvironment(source, { NPM_CONFIG_USERCONFIG: '/job/npmrc' }).YARN_NPM_AUTH_TOKEN,
    undefined,
    'prepared config replaces ambient registry credentials',
  );
  await old.cleanup();
});

test('queued local checks use project config, preserve personal scopes and clean up', async () => {
  const { tickChecks } = await import('./check-runner.ts');
  const cwd = join(root, 'check');
  await mkdir(cwd);
  const home = join(root, 'home');
  await mkdir(home);
  const personal = join(home, '.npmrc');
  await writeFile(
    personal,
    '@scope:registry=https://scope.invalid/\n//scope.invalid/:_authToken=personal\n',
  );
  const previous = process.env.NPM_CONFIG_USERCONFIG;
  process.env.NPM_CONFIG_USERCONFIG = personal;
  save('v2-project-policy', 'owner', { id: 'check-project', installThroughDeploy: false });
  save('task', 'owner', {
    id: 'check-task',
    projectId: 'check-project',
    workspacePath: cwd,
    revision: 0,
  });
  save('check', 'owner', {
    id: 'check',
    taskId: 'check-task',
    status: 'queued',
    timeoutMs: 5000,
    output: '',
    command:
      'test -z "$DEPLOY_WORKER_TOKEN" && test -f "$NPM_CONFIG_USERCONFIG" && printf "%s\\n" "$NPM_CONFIG_USERCONFIG" && cat "$NPM_CONFIG_USERCONFIG"',
  });
  try {
    tickChecks();
    tickChecks();
    const result = await until(() => {
      const value = get('check', 'owner', 'check');
      return value.status !== 'running' && value;
    });
    assert.equal(result.status, 'succeeded', result.output);
    assert.match(result.output, /registry=https:\/\/registry.npmjs.org/);
    assert.match(result.output, /@scope:registry=https:\/\/scope.invalid/);
    const npmrc = result.output.split('\n')[0];
    assert.equal(await stat(npmrc).catch(() => null), null);
  } finally {
    if (previous === undefined) delete process.env.NPM_CONFIG_USERCONFIG;
    else process.env.NPM_CONFIG_USERCONFIG = previous;
  }
});

for (const [adapter, mode] of [
  ['codex', 'registry'],
  ['codex', 'ping-fails'],
  ['codex', 'old-coordinator'],
  ['claude', 'registry'],
]) {
  test(
    `remote ${adapter} agent shells receive config and output is redacted (${mode})`,
    { timeout: 30000 },
    async () => {
      const { initializeScratchWorkspace } = await import('./scratch.ts');
      const directory = await mkdtemp(join(root, 'remote-'));
      const baseRevision = initializeScratchWorkspace(join(directory, 'baseline'));
      const binary = join(directory, 'codex-stub');
      const marker = join(directory, 'observed.json');
      await writeFile(
        join(directory, 'ps'),
        '#!/bin/sh\necho "Mon Jan  1 00:00:00 2024 S node fixture"\n',
        { mode: 0o755 },
      );
      for (const command of ['codex', 'claude', 'docker', 'swift', 'xcodebuild'])
        await writeFile(join(directory, command), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      await writeFile(
        binary,
        `#!${process.execPath}
const fs = require('node:fs');
const env = process.env;
const config = env.NPM_CONFIG_USERCONFIG ? fs.readFileSync(env.NPM_CONFIG_USERCONFIG, 'utf8') : '';
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ path: env.NPM_CONFIG_USERCONFIG, registry: /registry=([^\\n]+)/.exec(config)?.[1], worker: env.DEPLOY_WORKER_TOKEN, workspace: env.DEPLOY_WORKSPACE_TOKEN, mode: env.NPM_CONFIG_USERCONFIG ? fs.statSync(env.NPM_CONFIG_USERCONFIG).mode & 511 : null }));
process.stdout.write(JSON.stringify({ type: ${JSON.stringify(adapter === 'claude' ? 'result' : 'provider.output')}, text: config, result: config }) + '\\n');
`,
        { mode: 0o755 },
      );
      let assigned = false;
      let instanceId = '';
      let completed: any;
      let events: any[] = [];
      let packageRequests = 0;
      const server = createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : {};
        res.setHeader('content-type', 'application/json');
        if (req.url === '/npm/-/ping') {
          res.writeHead(mode === 'ping-fails' ? 503 : 200);
          res.end('{}');
          return;
        }
        let value: any = {};
        if (req.url?.endsWith('/register')) instanceId = body.instanceId;
        if (req.url === '/api/workspace/workers/remote/poll' && !assigned) {
          assigned = true;
          value = {
            run: {
              id: 'remote-run',
              taskId: 'remote-task',
              adapter,
              prompt: 'Install',
              status: 'starting',
              generation: 'g',
              assignedInstanceId: instanceId,
            },
            task: { id: 'remote-task', baseRevision },
            project: null,
            agentToken: 'agent-only',
          };
        }
        if (req.url?.endsWith('/jobs/packages')) {
          packageRequests++;
          assert.equal(body.runId, 'remote-run');
          assert.equal(body.generation, 'g');
          assert.equal(req.headers['x-deploy-worker-token'], 'enrollment-only');
          if (mode === 'old-coordinator') {
            res.writeHead(404);
            value = { error: 'unknown action' };
          } else value = { registry: origin + '/npm/', key, ca: '' };
        }
        if (req.url?.endsWith('/events')) {
          events.push(...body.events);
          value = { acknowledgedSequence: body.events.at(-1)?.sequence || 0 };
        }
        if (req.url?.endsWith('/complete') && body.runId) {
          completed = body;
          value = { status: body.status };
        }
        if (req.url?.includes('base-updates')) value = { operations: [] };
        res.end(JSON.stringify(value));
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const origin = `http://127.0.0.1:${(server.address() as any).port}`;
      const child = spawn(process.execPath, [resolve('server/workspace/remote-worker.ts')], {
        env: {
          ...process.env,
          NPM_CONFIG_USERCONFIG: undefined,
          PATH: directory + ':' + process.env.PATH,
          DEPLOY_WORKER_ROOT: directory,
          DEPLOY_WORKER_ID: 'remote',
          DEPLOY_WORKER_TOKEN: 'enrollment-only',
          DEPLOY_WORKSPACE_TOKEN: 'workspace-only',
          DEPLOY_COORDINATOR_URL: origin,
          DEPLOY_CODEX_BIN: binary,
          DEPLOY_CLAUDE_BIN: binary,
          DEPLOY_TERMINAL: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';

      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      try {
        await until(() => {
          if (child.exitCode !== null || child.signalCode !== null) throw Error(output);
          return completed;
        }, 20000).catch((error) => {
          throw Error(error.message + '\n' + output);
        });
        assert.equal(completed.status, 'succeeded', completed.error);
        assert.equal(packageRequests, 1);
        const observed = JSON.parse(await readFile(marker, 'utf8'));
        assert.equal(observed.worker, undefined);
        assert.equal(observed.workspace, undefined);
        assert.equal(
          observed.registry,
          mode === 'old-coordinator'
            ? undefined
            : mode === 'registry'
              ? origin + '/npm/'
              : 'https://registry.npmjs.org/',
        );
        if (observed.path) {
          assert.equal(observed.mode, 0o600);
          assert.equal(await stat(observed.path).catch(() => null), null);
        }
        assert.ok(!JSON.stringify(events).includes(key));
        if (mode === 'registry') assert.ok(JSON.stringify(events).includes('[redacted]'));
        if (mode === 'ping-fails') assert.ok(JSON.stringify(events).includes('unreachable'));
        assert.ok(!(await readFile(join(directory, 'assignment.json'), 'utf8')).includes(key));
        assert.deepEqual(await readdir(join(directory, 'agent-packages')).catch(() => []), []);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const stopped = once(child, 'close');
          child.kill('SIGTERM');
          const force = setTimeout(() => child.kill('SIGKILL'), 2000);
          await stopped;
          clearTimeout(force);
        }
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
      }
    },
  );
}

test('compatible agent shell uses the prepared config and redacts before provider requests and durable session writes', async () => {
  const directory = await mkdtemp(join(root, 'compatible-'));
  const npmrc = join(directory, 'npmrc');
  await writeFile(
    npmrc,
    `registry=https://deploy.local/npm/\n//deploy.local/npm/:_authToken=${key}\n`,
  );
  const session = join(directory, 'session.json');
  const pnpm = join(directory, 'pnpm');
  await writeFile(
    pnpm,
    '#!/bin/sh\ntest -z "$DEPLOY_WORKER_TOKEN" || exit 9\ncat "$NPM_CONFIG_USERCONFIG"\n',
    { mode: 0o755 },
  );
  let requests = 0;
  let toolOutput = '';
  const provider = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests++;
    if (requests > 1)
      toolOutput = body.messages.findLast((message: any) => message.role === 'tool')?.content || '';
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [
          {
            message:
              requests === 1
                ? {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'install',
                        type: 'function',
                        function: {
                          name: 'run_command',
                          arguments: JSON.stringify({ command: `${JSON.stringify(pnpm)} install` }),
                        },
                      },
                    ],
                  }
                : { role: 'assistant', content: 'Installed' },
          },
        ],
      }),
    );
  });
  await new Promise<void>((done) => provider.listen(0, '127.0.0.1', done));
  const child = spawn(process.execPath, [resolve('server/workspace/compatible-agent.ts')], {
    cwd: directory,
    env: {
      ...process.env,
      NPM_CONFIG_USERCONFIG: npmrc,
      DEPLOY_WORKER_TOKEN: 'must-not-enter-shell',
      DEPLOY_MODEL_BASE_URL: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
      DEPLOY_MODEL_NAME: 'fixture',
      DEPLOY_MODEL_BILLING_MODE: 'local',
      DEPLOY_MODEL_SESSION_FILE: session,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
  child.stdin.end('Install');
  try {
    const [code] = await once(child, 'close');
    assert.equal(code, 0, output);
    assert.equal(requests, 2);
    assert.match(toolOutput, /registry=https:\/\/deploy.local\/npm/);
    assert.match(toolOutput, /\[redacted\]/);
    assert.doesNotMatch(toolOutput, new RegExp(key));
    assert.ok(!output.includes(key));
    assert.ok(!(await readFile(session, 'utf8')).includes(key));
  } finally {
    clearTimeout(deadline);
    provider.closeAllConnections();
    await new Promise<void>((done) => provider.close(() => done()));
  }
});

test(
  'local agent launch retains config through its native shell environment and cleans up after concurrent queued runs',
  { timeout: 15000 },
  async () => {
    const { createTask } = await import('./test-repository.ts');
    const directory = await mkdtemp(join(root, 'local-'));
    for (const command of ['codex', 'claude', 'docker', 'swift', 'xcodebuild'])
      await writeFile(join(directory, command), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await writeFile(
      join(directory, 'ps'),
      '#!/bin/sh\necho "Mon Jan  1 00:00:00 2024 S node fixture"\n',
      { mode: 0o755 },
    );
    const personal = join(directory, 'personal.npmrc');
    await writeFile(
      personal,
      '@scope:registry=https://scope.invalid/\n//scope.invalid/:_authToken=personal-token\n',
    );
    const binary = join(directory, 'agent');
    await writeFile(
      binary,
      `#!${process.execPath}
const fs = require('node:fs');
if (process.env.DEPLOY_WORKER_TOKEN) process.exit(9);
const path = process.env.NPM_CONFIG_USERCONFIG;
fs.appendFileSync(${JSON.stringify(join(directory, 'launches'))}, path + '\\n');
console.log(JSON.stringify({ type: 'provider.output', text: fs.readFileSync(path, 'utf8') }));
`,
      { mode: 0o755 },
    );
    save('v2-project-policy', 'owner', { id: 'local-project', installThroughDeploy: false });
    const runs: string[] = [];
    for (const id of ['local-one', 'local-two']) {
      const task = createTask('owner', { title: id });
      // The fixture has a scratch checkout; only the package policy requires a project record.
      save('project', 'owner', { id: 'local-project', name: 'Fixture' });
      save('task', 'owner', { ...task, projectId: 'local-project' });
      save('run', 'owner', {
        id,
        taskId: task.id,
        status: 'queued',
        adapter: 'codex',
        workerId: 'local',
        prompt: 'Install',
        createdAt: new Date().toISOString(),
      });
      runs.push(id);
    }
    const child = spawn(process.execPath, [resolve('server/workspace/worker.ts')], {
      env: {
        ...process.env,
        PATH: directory + ':' + process.env.PATH,
        NPM_CONFIG_USERCONFIG: personal,
        DEPLOY_CODEX_BIN: binary,
        DEPLOY_WORKER_TOKEN: 'enrollment-only',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    try {
      await until(() => {
        if (child.exitCode !== null) throw Error(output);
        return runs.every((id) => get('run', 'owner', id).status === 'succeeded');
      }, 10000).catch((error) => {
        throw Error(error.message + '\n' + output);
      });
      const paths = (await readFile(join(directory, 'launches'), 'utf8')).trim().split('\n');
      assert.equal(paths.length, 2, 'each queued run starts once');
      for (const path of paths) assert.equal(await stat(path).catch(() => null), null);
      const events = db.prepare('SELECT payload FROM events WHERE owner = ?').all('owner');
      assert.ok(!JSON.stringify(events).includes('personal-token'));
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, 'close');
        child.kill('SIGTERM');
        const force = setTimeout(() => child.kill('SIGKILL'), 2000);
        await stopped;
        clearTimeout(force);
      }
    }
  },
);

test('container job and removal receive only install environment; secrets and host npmrc never enter the image', async () => {
  const { JobRunner } = await import('./job-runner.ts');
  const { captureSnapshot } = await import('./checkpoint.ts');
  const { initializeScratchWorkspace } = await import('./scratch.ts');
  const directory = await mkdtemp(join(root, 'container-job-'));
  const source = join(directory, 'source');
  initializeScratchWorkspace(source);
  const personal = join(directory, 'personal');
  await writeFile(
    personal,
    '@scope:registry=https://private.invalid/\n//private.invalid/:_authToken=private-token\n',
  );
  const calls = join(directory, 'calls');
  await writeFile(
    join(directory, 'docker'),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const npmrc = args[0] === 'run' ? args.find((arg) => arg.endsWith(':/run/deploy-packages:ro')).split(':')[0] + '/npmrc' : '';
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, config: process.env.NPM_CONFIG_USERCONFIG, worker: process.env.DEPLOY_WORKER_TOKEN, npmrc }) + '\\n');
if (npmrc) process.stdout.write(fs.readFileSync(npmrc, 'utf8'));
`,
    { mode: 0o755 },
  );
  const server = createServer((_req, res) => res.end('{}'));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const previous = {
    PATH: process.env.PATH,
    NPM_CONFIG_USERCONFIG: process.env.NPM_CONFIG_USERCONFIG,
    DEPLOY_WORKER_TOKEN: process.env.DEPLOY_WORKER_TOKEN,
  };
  Object.assign(process.env, {
    PATH: directory + ':' + previous.PATH,
    NPM_CONFIG_USERCONFIG: personal,
    DEPLOY_WORKER_TOKEN: 'enrollment',
  });
  let polled = false;
  let result: any;
  const runner = new JobRunner(join(directory, 'jobs'), async (action, body) => {
    if (action === 'packages')
      return {
        registry: `http://127.0.0.1:${(server.address() as any).port}/npm/`,
        key,
        ca: '',
        address: '192.0.2.1',
      };
    if (action === 'poll' && !polled) {
      polled = true;
      return {
        job: {
          id: 'job',
          generation: 'g',
          instanceId: 'i',
          container: 'fixture-image',
          command: 'pnpm install',
          timeoutMs: 5000,
        },
        snapshot: captureSnapshot(source),
      };
    }
    if (action === 'complete') result = body;
    return {};
  });
  try {
    await until(async () => {
      await runner.tick();
      return result;
    });
    assert.equal(result.status, 'succeeded', result.output);
    assert.ok(result.output.includes('[redacted]'));
    assert.ok(!result.output.includes(key));
    assert.ok(!result.output.includes('private.invalid'));
    assert.ok(!result.output.includes('private-token'));
    const invocations = (await readFile(calls, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(invocations.length, 2);
    assert.deepEqual(invocations[1].args, ['rm', '-f', 'deploy-job-job-g']);
    for (const call of invocations) {
      assert.equal(call.config, '/run/deploy-packages/npmrc');
      assert.equal(call.worker, undefined);
    }
    assert.equal(await stat(invocations[0].npmrc).catch(() => null), null);
  } finally {
    runner.shutdown();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
