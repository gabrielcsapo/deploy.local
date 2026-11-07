import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkerManager } from '../src/worker.mjs';
import { servicePath, discoverProviderPaths } from '../src/worker-path.mjs';
import { servicePath as installedServicePath } from '../../bin/agent-services.mjs';

const barePath = '/usr/bin:/bin:/usr/sbin:/sbin';

function fixture(t) {
  const home = mkdtempSync(new URL('../.worker-path-test-', import.meta.url));
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

for (const inherited of [barePath, `${barePath}:/custom/bin:/usr/local/bin:/custom/bin`]) {
  test(
    `desktop child gets the service PATH with ${inherited === barePath ? 'a bare app PATH' : 'custom and duplicate PATH entries'}`,
    {
      skip: process.platform === 'win32',
    },
    async (t) => {
      const { home, write, node } = fixture(t);
      const bin = node('v22.12.0');
      node('v24.1.0');
      write('.nvm/alias/default', 'lts/*\n');
      write('.nvm/alias/lts/*', 'lts/jod\n');
      write('.nvm/alias/lts/jod', 'v22.12.0\n');
      write(
        '.nvm/versions/node/v22.12.0/bin/pnpm',
        '#!/usr/bin/env node\nconsole.log("fixture-pnpm");\n',
        0o755,
      );
      const previous = { HOME: process.env.HOME, PATH: process.env.PATH };
      process.env.HOME = home;
      process.env.PATH = inherited;
      t.after(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      });
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
      const result = spawnSync('pnpm', [], { env: childEnv, encoding: 'utf8' });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), 'fixture-pnpm');
    },
  );
}

test('shared worker PATH resolves nvm version prefixes numerically and tolerates missing or cyclic aliases', (t) => {
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
});

test(
  'shared worker PATH keeps provider shims, their real installation directories and inherited entries once',
  {
    skip: process.platform === 'win32',
  },
  (t) => {
    const { home, write } = fixture(t);
    const provider = write('provider/bin/codex', '#!/bin/sh\n', 0o755);
    mkdirSync(join(home, 'shims'));
    symlinkSync(provider, join(home, 'shims/codex'));
    const inherited = `${join(home, 'shims')}:${barePath}:/custom/bin:/custom/bin`;
    const providers = discoverProviderPaths(inherited);
    assert.deepEqual(providers, [join(home, 'shims/codex'), provider]);
    const directories = servicePath(providers, inherited, home).split(':');
    assert.deepEqual(directories.slice(0, 2), [join(home, 'shims'), join(home, 'provider/bin')]);
    assert.ok(directories.includes('/custom/bin'));
    assert.equal(directories.length, new Set(directories).size);
  },
);
