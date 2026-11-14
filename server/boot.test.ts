// `server.ts` and `server/index.ts` once drifted: only the built server started Git SSH and the
// Packages hooks and copies, so Packages tests passed from source while installs on SER failed.
// These tests fail if either entry point starts something the other does not.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer, connect, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const root = process.cwd();
const dataRoot = mkdtempSync(join(tmpdir(), 'deploy-boot-'));
after(() => rmSync(dataRoot, { recursive: true, force: true }));

const source = (file: string) => readFileSync(join(root, file), 'utf8');

function staticImports(text: string) {
  return [
    ...text.matchAll(/^\s*(?:import|export)\b[^'"\n;]*(?:\{[^}]*\}[^'"\n;]*)?['"]([^'"]+)['"]/gm),
  ]
    .map((match) => match[1])
    .sort();
}

/** The whole option list each entry may pass. A new one is a new way for them to differ. */
function bootOptions(text: string) {
  const calls = text.split(/\bbootServer\(\{/);
  assert.equal(calls.length, 2, 'An entry point must call bootServer exactly once');
  return [...calls[1].matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]).sort();
}

const entries = {
  'server.ts': {
    imports: ['./server/boot.ts', './server/flight-router-error.ts', 'react-flight-router/server'],
    options: ['createClient', 'role'],
  },
  'server/index.ts': {
    imports: ['./boot.ts', './dev-ui.ts', './error-page.ts'],
    options: ['createClient', 'gitSshPort', 'role'],
  },
};

for (const [file, expected] of Object.entries(entries)) {
  test(`${file} starts nothing of its own`, () => {
    const text = source(file);
    assert.deepEqual(
      staticImports(text),
      [...expected.imports].sort(),
      'Start services in server/boot.ts so development and production keep running the same things',
    );
    assert.doesNotMatch(text, /\bimport\(|\brequire\(/, 'Entry points load modules statically');
    assert.deepEqual(bootOptions(text), [...expected.options].sort());
  });
}

test('the shared boot starts every service in every role', () => {
  const boot = source('server/boot.ts');
  // One startGitSshServer call per role branch; one startupTasks definition both roles run.
  assert.equal(boot.match(/await startGitSshServer\(/g)?.length, 2);
  assert.equal(boot.match(/\bstartupTasks\(`/g)?.length, 2);
  assert.match(boot, /^import '\.\/packages\/hooks\.ts';$/m);
  const tasks = boot.match(/function startupTasks\([^]*?\n {2}\}\n/)?.[0] ?? '';
  for (const service of [
    'startManagedWorkers(',
    'cleanupStaleBuildLogs(',
    'syncContainerStates(',
    'startAllContainers(',
    'npmRegistry.copy.startChecks(',
    'queueAllCopies(',
    'new CopyWarmer(',
    'cleanupCopies(',
    'startMaintenance(',
  ])
    assert.ok(tasks.includes(service), `startupTasks must call ${service}`);
});

test('development cannot take Git SSH from a production server on the same machine', () => {
  const dev = source('server/index.ts').match(/DEV_GIT_SSH_PORT = (\d+)/)?.[1];
  assert.ok(dev);
  assert.notEqual(Number(dev), 2222);
});

// ── Both entry points, really booted ─────────────────────────────────────

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on('error', reject);
  });
}

// Runs inside the booted process, so it reads the very module instances the entry point loaded.
const inspector = `
const delays = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, delay, ...rest) => {
  delays.push(delay);
  return realSetInterval(fn, delay, ...rest);
};
await import(process.env.BOOT_ENTRY);
process.on('message', async (message) => {
  if (message !== 'inspect') return;
  const at = (path) => import(new URL(path, process.env.BOOT_ROOT).href);
  const { sshServerInfo } = await at('server/workspace/ssh-host.ts');
  const { packageHooks } = await at('server/workspace/package-hooks.ts');
  const { npmRegistry } = await at('server/packages/npm.ts');
  let hooksInstalled = true;
  try {
    await packageHooks.publishConfig('nobody', {});
  } catch (error) {
    hooksInstalled = !/unavailable on this coordinator/.test(error.message);
  }
  process.send({
    inspected: {
      gitSsh: sshServerInfo().enabled,
      gitSshPort: sshServerInfo().port,
      hooksInstalled,
      copyChecks: npmRegistry.copy.timer !== undefined,
      copyWarmer: delays.includes(5000),
      // The schedule check; the 6-hour interval itself is kept in the database.
      maintenance: delays.includes(15 * 60 * 1000),
      integrityChecks: delays.includes(10 * 60 * 1000),
    },
  });
});
`;

async function bootEntry(entry: string, env: Record<string, string>, ready: RegExp) {
  const dataDir = mkdtempSync(join(dataRoot, 'run-'));
  const child = spawn(process.execPath, ['--input-type=module', '--eval', inspector], {
    cwd: root,
    env: {
      ...process.env,
      BOOT_ENTRY: new URL(entry, `file://${root}/`).href,
      BOOT_ROOT: `file://${root}/`,
      DEPLOY_DATA_DIR: dataDir,
      // Never answer for deploy.local on the network or reach a real Docker daemon from a test.
      DEPLOY_MDNS_ADDRESS: '127.0.0.1',
      DOCKER_HOST: 'unix:///nonexistent/docker.sock',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  const collect = (chunk: Buffer) => (output += chunk);
  child.stdout!.on('data', collect);
  child.stderr!.on('data', collect);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${entry} did not start: ${output}`)), 60_000);
    const check = () => {
      if (!ready.test(output)) return;
      clearTimeout(timer);
      child.stdout!.off('data', check);
      resolve();
    };
    child.stdout!.on('data', check);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${entry} exited with ${code}: ${output}`));
    });
  });
  child.removeAllListeners('exit');
  return { child, dataDir, output: () => output };
}

function inspect(child: ChildProcess) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No answer from the booted process')), 15_000);
    const onMessage = (message: any) => {
      if (!message?.inspected) return;
      clearTimeout(timer);
      child.off('message', onMessage);
      resolve(message.inspected);
    };
    child.on('message', onMessage);
    child.send('inspect');
  });
}

function sshBanner(port: number) {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('data', (chunk) => {
      socket.destroy();
      resolve(chunk.toString());
    });
    socket.once('error', reject);
  });
}

/** Status of a registry request with no key: 401 means the route is mounted and answering. */
function registryStatus(port: number, secure: boolean) {
  const request = secure ? httpsRequest : httpRequest;
  return new Promise<number>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/npm/-/whoami', rejectUnauthorized: false },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.once('error', reject);
    req.end();
  });
}

async function stop(child: ChildProcess) {
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  return exited;
}

const expectedServices = {
  gitSsh: true,
  hooksInstalled: true,
  copyChecks: true,
  copyWarmer: true,
  maintenance: true,
  integrityChecks: true,
};

for (const entry of ['server.ts', 'server/index.ts']) {
  test(
    `${entry} boots every service in one process and stops cleanly`,
    { timeout: 120_000 },
    async () => {
      const [httpPort, httpsPort, sshPort] = await Promise.all([
        freePort(),
        freePort(),
        freePort(),
      ]);
      const { child, dataDir } = await bootEntry(
        entry,
        { PORT: String(httpPort), HTTPS_PORT: String(httpsPort), DEPLOY_SSH_PORT: String(sshPort) },
        /running on/,
      );
      try {
        assert.deepEqual(await inspect(child), { ...expectedServices, gitSshPort: sshPort });
        assert.equal(readFileSync(join(dataDir, 'secrets', 'master.key')).length, 32);
        assert.match(await sshBanner(sshPort), /^SSH-2\.0-/);
        assert.equal(await registryStatus(httpsPort, true), 401);
      } finally {
        assert.equal(await stop(child), 0);
      }
      await assert.rejects(sshBanner(sshPort), /ECONNREFUSED/);
    },
  );
}

for (const entry of ['server.ts', 'server/index.ts']) {
  test(
    `${entry} refuses to start when master.key is missing and encrypted data exists`,
    { timeout: 120_000 },
    async () => {
      const dataDir = mkdtempSync(join(dataRoot, 'lost-key-'));
      mkdirSync(join(dataDir, 'workspace'));
      const workspace = new Database(join(dataDir, 'workspace', 'workspace.db'));
      workspace.exec(`CREATE TABLE records(kind TEXT, id TEXT, owner TEXT, data TEXT);
        INSERT INTO records VALUES
          ('provider-connection', 'openai', 'admin', '{"secret":"v1:a:b:c"}')`);
      workspace.close();
      const keyPath = join(dataDir, 'secrets', 'master.key');
      const child = spawn(process.execPath, [entry], {
        cwd: root,
        env: {
          ...process.env,
          DEPLOY_DATA_DIR: dataDir,
          DEPLOY_SECRET_KEY: '',
          DEPLOY_MDNS_ADDRESS: '127.0.0.1',
          DOCKER_HOST: 'unix:///nonexistent/docker.sock',
          PORT: '0',
          HTTPS_PORT: '0',
          DEPLOY_SSH_PORT: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout!.on('data', (chunk: Buffer) => (output += chunk));
      child.stderr!.on('data', (chunk: Buffer) => (output += chunk));
      const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
      assert.equal(code, 1, output);
      assert.ok(
        output.includes(
          `Failed to start server: Error: The secret-store key is missing: ${keyPath}`,
        ),
        output,
      );
      assert.match(output, /workspace\/workspace\.db \(provider keys/);
      assert.equal(existsSync(keyPath), false, 'No new key is created');
    },
  );
}

test(
  'the control role behind the supervisor boots the same services',
  { timeout: 120_000 },
  async () => {
    const [controlPort, sshPort] = await Promise.all([freePort(), freePort()]);
    const { child } = await bootEntry(
      'server.ts',
      {
        DEPLOY_ROLE: 'control',
        CONTROL_PORT: String(controlPort),
        DEPLOY_SSH_PORT: String(sshPort),
      },
      /\[control\] listening/,
    );
    try {
      assert.deepEqual(await inspect(child), { ...expectedServices, gitSshPort: sshPort });
      assert.match(await sshBanner(sshPort), /^SSH-2\.0-/);
      assert.equal(await registryStatus(controlPort, false), 401);
    } finally {
      assert.equal(await stop(child), 0);
    }
  },
);

test(
  'a busy Git SSH port is reported and does not stop the server',
  { timeout: 120_000 },
  async () => {
    const busy: Server = createServer();
    await new Promise<void>((resolve) => busy.listen(0, '0.0.0.0', resolve));
    const sshPort = (busy.address() as AddressInfo).port;
    const [httpPort, httpsPort] = await Promise.all([freePort(), freePort()]);
    const { child, output } = await bootEntry(
      'server/index.ts',
      { PORT: String(httpPort), HTTPS_PORT: String(httpsPort), DEPLOY_SSH_PORT: String(sshPort) },
      /running on/,
    );
    try {
      const seen = await inspect(child);
      assert.equal(seen.gitSsh, false);
      assert.equal(seen.gitSshPort, null);
      assert.equal(seen.copyWarmer, true);
      assert.match(output(), /\[ssh\] Git SSH listener failed: .*EADDRINUSE/);
    } finally {
      // Close the listener even when the server did not stop cleanly: a listener left
      // open keeps this test file running forever and hangs an update's prepare step.
      const code = await stop(child);
      await new Promise((resolve) => busy.close(resolve));
      assert.equal(code, 0);
    }
  },
);
