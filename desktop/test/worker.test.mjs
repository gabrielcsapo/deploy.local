import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerManager } from '../src/worker.mjs';
import { servicePath, discoverProviderPaths } from '../src/worker-path.mjs';
import {
  servicePath as installedServicePath,
  discoverProviderPaths as installedDiscoverProviderPaths,
} from '../../bin/agent-services.mjs';

const barePath = '/usr/bin:/bin:/usr/sbin:/sbin';
// Symlinks, ':' separators and a '*' in a file name: the service PATH is only used on macOS and Linux.
const posixOnly = { skip: process.platform === 'win32' };
// No machine has this on its PATH, unlike pnpm, so only the fixture's nvm directory can provide it.
const fixtureTool = 'deploy-worker-path-fixture-tool';

function fixture(t) {
  // realpath: macOS's temp directory is a symlink, and provider discovery resolves symlinks.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'deploy-worker-path-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const write = (path, content, mode) => {
    const file = join(home, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content, { mode });
    return file;
  };
  const node = (version) => {
    const bin = join(home, '.nvm/versions/node', version, 'bin');
    mkdirSync(bin, { recursive: true });
    symlinkSync(process.execPath, join(bin, 'node'));
    return bin;
  };
  return { home, write, node };
}

/** Configure a WorkerManager with a fake child, and return the environment it was given. */
async function childEnvironment(t, home) {
  let childEnv;
  const manager = new WorkerManager({
    root: join(home, 'worker'),
    executable: '/runtime',
    entry: '/worker.mjs',
    nodeId: () => undefined,
    spawnChild: (command, args, { env }) => {
      assert.equal(command, '/runtime');
      assert.deepEqual(args, ['/worker.mjs']);
      childEnv = env;
      const child = new EventEmitter();
      child.kill = () => queueMicrotask(() => child.emit('exit', 0));
      return child;
    },
  });
  t.after(() => manager.stop());
  await manager.configure(
    { takeTasks: true },
    { origin: 'https://deploy.local' },
    { workerId: 'desktop-fixture', workerToken: 'test-token' },
  );
  return childEnv;
}

function useEnvironment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

for (const inherited of [barePath, `${barePath}:/custom/bin:/usr/local/bin:/custom/bin`]) {
  test(
    `desktop child gets the service PATH with ${inherited === barePath ? 'a bare app PATH' : 'custom and duplicate PATH entries'}`,
    posixOnly,
    async (t) => {
      const { home, write, node } = fixture(t);
      const bin = node('v22.12.0');
      node('v24.1.0');
      write('.nvm/alias/default', 'lts/*\n');
      write('.nvm/alias/lts/*', 'lts/jod\n');
      write('.nvm/alias/lts/jod', 'v22.12.0\n');
      write(
        `.nvm/versions/node/v22.12.0/bin/${fixtureTool}`,
        '#!/usr/bin/env node\nconsole.log("fixture-tool");\n',
        0o755,
      );
      useEnvironment(t, { HOME: home, PATH: inherited });
      const childEnv = await childEnvironment(t, home);
      const directories = childEnv.PATH.split(':');
      for (const directory of [
        bin,
        join(home, '.local/bin'),
        join(home, '.npm-global/bin'),
        join(home, '.cargo/bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        ...inherited.split(':'),
      ])
        assert.ok(directories.includes(directory), `Missing PATH directory: ${directory}`);
      assert.equal(directories.length, new Set(directories).size);
      assert.equal(
        childEnv.PATH,
        installedServicePath(discoverProviderPaths(inherited), inherited, home),
      );
      const result = spawnSync(fixtureTool, [], { env: childEnv, encoding: 'utf8' });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), 'fixture-tool');
    },
  );
}

test('desktop child on Windows keeps the inherited PATH exactly', async (t) => {
  const { home } = fixture(t);
  const inherited = 'C:\\Windows\\system32;C:\\Tools;C:\\Tools';
  useEnvironment(t, { PATH: inherited });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    assert.equal((await childEnvironment(t, home)).PATH, inherited);
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

test('the CLI keeps exporting the shared provider discovery', () => {
  assert.equal(installedDiscoverProviderPaths, discoverProviderPaths);
});

test('service PATH keeps its order, and an nvm default is the only addition', posixOnly, (t) => {
  const { home, write, node } = fixture(t);
  const before = [
    '/tools/bin',
    join(home, '.local/bin'),
    join(home, '.npm-global/bin'),
    join(home, '.cargo/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    '/custom/bin',
  ];
  const path = () => installedServicePath(['/tools/bin/codex'], '/custom/bin:relative:', home);
  assert.deepEqual(path().split(':'), before);
  const bin = node('v22.12.0');
  write('.nvm/alias/default', '22\n');
  assert.deepEqual(path().split(':'), [before[0], bin, ...before.slice(1)]);
});

test(
  'shared worker PATH resolves nvm version prefixes numerically and tolerates missing or cyclic aliases',
  posixOnly,
  (t) => {
    const { home, write, node } = fixture(t);
    node('v22.9.0');
    const selected = node('v22.12.0');
    const stable = node('v24.1.0');
    const latest = node('v25.1.0');
    for (const [alias, expected] of [
      ['22', selected],
      ['v22.12.0', selected],
      ['node', latest],
      ['stable', stable],
    ]) {
      write('.nvm/alias/default', `${alias}\n`);
      assert.ok(servicePath([], barePath, home).split(':').includes(expected));
    }
    for (const alias of ['missing', 'default', '../../outside', 'v20.1.0']) {
      write('.nvm/alias/default', alias);
      const path = servicePath([], barePath, home);
      assert.ok(!path.includes('/versions/node/'));
      assert.ok(path.split(':').includes('/opt/homebrew/bin'));
    }
    rmSync(join(home, '.nvm'), { recursive: true });
    assert.ok(servicePath([], '', home).split(':').includes('/usr/local/bin'));
  },
);

test(
  'shared worker PATH keeps provider shims, their real installation directories and inherited entries once',
  posixOnly,
  (t) => {
    const { home, write } = fixture(t);
    const provider = write('provider/bin/codex', '#!/bin/sh\n', 0o755);
    mkdirSync(join(home, 'shims'));
    symlinkSync(provider, join(home, 'shims/codex'));
    // Only fixture directories: a real /usr/bin may hold a claude or codex of its own.
    const inherited = `${join(home, 'shims')}:/custom/bin:/custom/bin`;
    const providers = discoverProviderPaths(inherited);
    assert.deepEqual(providers, [join(home, 'shims/codex'), provider]);
    const directories = servicePath(providers, inherited, home).split(':');
    assert.deepEqual(directories.slice(0, 2), [join(home, 'shims'), join(home, 'provider/bin')]);
    assert.ok(directories.includes('/custom/bin'));
    assert.equal(directories.length, new Set(directories).size);
  },
);
