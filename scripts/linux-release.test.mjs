import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import {
  artifactHashes,
  pointCurrent,
  promote,
  releaseLocation,
  restartRule,
  verifyRelease,
  releaseOverride,
  waitForHealthy,
  supportsReadiness,
} from './linux-release.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deploy-release-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const releases = join(root, 'releases');
  mkdirSync(releases);
  const previous = join(releases, 'previous'),
    next = join(releases, 'next');
  mkdirSync(previous);
  mkdirSync(next);
  const current = join(root, 'current');
  pointCurrent(current, previous);
  return { root, releases, previous, next, current };
}

test('restart authorization matches only the designated account, action, service and verb', () => {
  let rule;
  runInNewContext(restartRule('deployer'), {
    polkit: {
      Result: { YES: 'allowed' },
      addRule: (callback) => {
        rule = callback;
      },
    },
  });
  function authorize({
    user = 'deployer',
    id = 'org.freedesktop.systemd1.manage-units',
    unit = 'deploy-server.service',
    verb = 'restart',
  } = {}) {
    return rule({ id, lookup: (key) => ({ unit, verb })[key] }, { user });
  }
  assert.equal(authorize(), 'allowed');
  for (const input of [
    { user: 'other' },
    { user: 'root' },
    { unit: 'sshd.service' },
    { unit: 'deploy-server@other.service' },
    { verb: 'start' },
    { verb: 'stop' },
    { verb: 'reload' },
    { verb: 'kill' },
    { verb: 'set-property' },
    { id: 'org.freedesktop.systemd1.reload-daemon' },
    { id: 'org.freedesktop.systemd1.manage-unit-files' },
  ])
    assert.equal(authorize(input), undefined, JSON.stringify(input));
  assert.throws(() => restartRule('deployer" || true'), /Invalid deploy user/);
});

test('service override uses one stable pointer, preserves the existing data directory and does not expand unit specifiers', () => {
  const output = releaseOverride({
    current: '/home/deployer/releases/current',
    node: '/opt/node/bin/node',
    data: '/srv/deploy data/%private',
  });
  assert.match(output, /WorkingDirectory=\/home\/deployer\/releases\/current\n/);
  assert.match(output, /ExecStart=\nExecStart="\/opt\/node\/bin\/node"/);
  assert.match(output, /DEPLOY_DATA_DIR=\/srv\/deploy data\/%%private/);
  assert.doesNotMatch(output, /User=|Group=|Capability|chmod|chown/);
});

test(
  'generated override passes the installed systemd parser',
  { skip: process.platform !== 'linux' },
  (t) => {
    const f = fixture(t);
    const unit = join(f.root, 'deploy-release-test.service');
    writeFileSync(
      unit,
      '[Unit]\nDescription=Release test\n[Service]\nType=simple\n' +
        releaseOverride({ current: f.current, node: process.execPath, data: f.root }),
    );
    execFileSync('systemd-analyze', ['verify', unit], { encoding: 'utf8' });
  },
);

test('release paths reject nested directories, external paths and escaping symlinks', (t) => {
  const f = fixture(t);
  assert.equal(releaseLocation(f.next, f.releases), f.next);
  const nested = join(f.next, 'nested');
  mkdirSync(nested);
  const escape = join(f.releases, 'escape');
  symlinkSync(f.root, escape);
  for (const path of [f.root, nested, escape])
    assert.throws(() => releaseLocation(path, f.releases), /direct directory/);
});

test('pointer replacement is atomic and refuses to replace an ordinary directory', (t) => {
  const f = fixture(t);
  pointCurrent(f.current, f.next);
  assert.equal(realpathSync(f.current), f.next);
  assert.throws(() => pointCurrent(f.previous, f.next), /not a symlink/);
});

test('validation failure leaves the active pointer and service untouched', async (t) => {
  const f = fixture(t);
  let restarted = false;
  await assert.rejects(
    promote({
      ...f,
      release: f.next,
      validate() {
        throw new Error('invalid artifacts');
      },
      restart() {
        restarted = true;
      },
      healthy() {},
    }),
    /invalid artifacts/,
  );
  assert.equal(realpathSync(f.current), f.previous);
  assert.equal(restarted, false);
});

test('successful promotion restarts after selecting the release and verifies readiness', async (t) => {
  const f = fixture(t),
    actions = [];
  await promote({
    ...f,
    release: f.next,
    validate: (target) => actions.push(['validated', target]),
    restart() {
      actions.push(['restart', realpathSync(f.current)]);
    },
    healthy: (target) => actions.push(['healthy', target]),
  });
  assert.deepEqual(actions, [
    ['validated', f.next],
    ['restart', f.next],
    ['healthy', f.next],
  ]);
});

test('readiness failure restores the previous pointer and restarts the previous release', async (t) => {
  const f = fixture(t),
    starts = [];
  await assert.rejects(
    promote({
      ...f,
      release: f.next,
      validate() {},
      restart() {
        starts.push(realpathSync(f.current));
      },
      healthy(target) {
        if (target === f.next) throw new Error('bad release');
      },
    }),
    /restored/,
  );
  assert.deepEqual(starts, [f.next, f.previous]);
  assert.equal(realpathSync(f.current), f.previous);
});

test('rollback failure still restores the pointer and reports both failures', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    promote({
      ...f,
      release: f.next,
      validate() {},
      restart() {
        throw new Error('restart denied');
      },
      healthy() {},
    }),
    (error) => error instanceof AggregateError && error.errors.length === 2,
  );
  assert.equal(realpathSync(f.current), f.previous);
});

test('verification rejects artifact tampering, tracked edits and a stale revision', (t) => {
  const f = fixture(t),
    release = f.next;
  const git = (args) => execFileSync('git', ['-C', release, ...args], { encoding: 'utf8' }).trim();
  git(['init', '--quiet']);
  writeFileSync(join(release, 'source.txt'), 'source');
  writeFileSync(
    join(release, 'package.json'),
    JSON.stringify({ dependencies: { 'react-flight-router': 'workspace:*' } }),
  );
  git(['add', 'source.txt', 'package.json']);
  git([
    '-c',
    'user.name=Release Test',
    '-c',
    'user.email=release@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  mkdirSync(join(release, 'dist'));
  for (const name of ['supervisor.js', 'server.js', 'edge.js'])
    writeFileSync(join(release, 'dist', name), name);
  const routerDist = join(release, 'packages/react-flight-router/dist');
  for (const name of ['index.js', 'server/index.js', 'client/index.js', 'router/index.js']) {
    mkdirSync(join(routerDist, name, '..'), { recursive: true });
    writeFileSync(join(routerDist, name), name);
  }
  const manifest = {
    revision: git(['rev-parse', 'HEAD']),
    typecheck: 'passed',
    build: 'passed',
    tests: 'passed',
    artifacts: artifactHashes(release),
  };
  const save = (value) =>
    writeFileSync(join(release, '.deploy-release.json'), JSON.stringify(value));
  save(manifest);
  assert.equal(verifyRelease(release).revision, manifest.revision);
  writeFileSync(join(routerDist, 'server/index.js'), 'tampered router');
  assert.throws(() => verifyRelease(release), /artifacts changed/);
  writeFileSync(join(routerDist, 'server/index.js'), 'server/index.js');
  rmSync(routerDist, { recursive: true });
  assert.throws(() => verifyRelease(release), /missing its workspace router/);
  for (const name of ['index.js', 'server/index.js', 'client/index.js', 'router/index.js']) {
    mkdirSync(join(routerDist, name, '..'), { recursive: true });
    writeFileSync(join(routerDist, name), name);
  }
  writeFileSync(join(release, 'dist/server.js'), 'tampered');
  assert.throws(() => verifyRelease(release), /artifacts changed/);
  writeFileSync(join(release, 'dist/server.js'), 'server.js');
  save({ ...manifest, revision: 'different' });
  assert.throws(() => verifyRelease(release), /current revision/);
  save(manifest);
  writeFileSync(join(release, 'source.txt'), 'changed');
  assert.throws(() => verifyRelease(release), /modified tracked files/);
  assert.equal(readFileSync(join(release, 'dist/server.js'), 'utf8'), 'server.js');
});

test('build manifests reject missing entry points and symlinked artifacts', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.next, 'dist'));
  assert.throws(() => artifactHashes(f.next), /missing its production entry points/);
  symlinkSync('/etc/passwd', join(f.next, 'dist/supervisor.js'));
  assert.throws(() => artifactHashes(f.next), /symlink/);
});

function readinessFixture(t, protocol = true) {
  const f = fixture(t);
  writeFileSync(
    join(f.next, '.deploy-release.json'),
    JSON.stringify({ revision: 'new-revision', ...(protocol ? { readiness: 1 } : {}) }),
  );
  writeFileSync(
    join(f.previous, '.deploy-release.json'),
    JSON.stringify({ revision: 'old-revision' }),
  );
  pointCurrent(f.current, f.next);
  const checks = Object.fromEntries(
    ['migrations', 'deploy', 'workspace', 'pipelines', 'repositories', 'version'].map((name) => [
      name,
      'ok',
    ]),
  );
  const response = { ok: true, version: 'new-revision', checks };
  const urls = [],
    sleeps = [];
  const runCommand = (command, args) => {
    if (command === 'systemctl')
      return args.includes('MainPID') ? '20' : args.includes('WorkingDirectory') ? f.current : '';
    assert.equal(command, 'curl');
    assert.ok(args.includes('deploy.local:443:127.0.0.1'));
    urls.push(args.at(-1));
    return JSON.stringify(response);
  };
  return {
    ...f,
    config: { current: f.current, data: f.root },
    response,
    urls,
    sleeps,
    options: {
      runCommand,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  };
}

test('activation requires readiness JSON from the selected version and checks again after a minute', async (t) => {
  const f = readinessFixture(t);
  await waitForHealthy(f.config, f.next, '19', f.options);
  assert.deepEqual(f.urls, [
    'https://deploy.local/api/health/ready',
    'https://deploy.local/api/health/ready',
  ]);
  assert.deepEqual(f.sleeps, [60000]);
});

test('activation waits for the immediate integrity scan within its existing retry window', async (t) => {
  const f = readinessFixture(t);
  f.response.ok = false;
  f.response.checks.deploy = f.response.checks.workspace = 'integrity check pending';
  await waitForHealthy(f.config, f.next, '19', {
    ...f.options,
    sleep: async (ms) => {
      await f.options.sleep(ms);
      if (f.sleeps.length === 3) {
        f.response.ok = true;
        f.response.checks.deploy = f.response.checks.workspace = 'ok';
      }
    },
  });
  assert.deepEqual(f.sleeps, [1000, 1000, 1000, 60000]);
});

test('HTML fallback, wrong version, missing checks and unhealthy workers cannot pass readiness', async (t) => {
  for (const response of [
    '<html>OK</html>',
    JSON.stringify({ ok: true }),
    JSON.stringify({ ok: true, version: 'wrong', checks: {} }),
  ]) {
    const f = readinessFixture(t);
    const runCommand = (command, args) =>
      command === 'curl' ? response : f.options.runCommand(command, args);
    await assert.rejects(
      waitForHealthy(f.config, f.next, '19', { ...f.options, runCommand }),
      /did not become ready/,
    );
    assert.equal(f.sleeps.length, 30);
  }
  const f = readinessFixture(t);
  f.response.checks.repositories = 'worker heartbeat stale';
  await assert.rejects(waitForHealthy(f.config, f.next, '19', f.options), /did not become ready/);
});

test('a failure at the minute check restores the old release and verifies it using the legacy probe', async (t) => {
  const f = readinessFixture(t);
  pointCurrent(f.current, f.previous);
  const modes = [];
  await assert.rejects(
    promote({
      current: f.current,
      release: f.next,
      validate() {},
      restart() {},
      healthy: (release, mode) => {
        modes.push(mode.rollback);
        return waitForHealthy(f.config, release, '19', {
          ...f.options,
          ...mode,
          sleep: async (ms) => {
            f.sleeps.push(ms);
            if (ms === 60000) f.response.checks.pipelines = 'worker heartbeat stale';
          },
        });
      },
    }),
    /restored/,
  );
  assert.deepEqual(modes, [false, true]);
  assert.deepEqual(f.urls, [
    'https://deploy.local/api/health/ready',
    'https://deploy.local/api/health/ready',
    'https://deploy.local/',
  ]);
  assert.deepEqual(f.sleeps, [60000]);
  assert.equal(realpathSync(f.current), f.previous);
});

test('both updater orders work: old prepare can select a new endpoint, and old targets retain their legacy probe', async (t) => {
  const f = readinessFixture(t, false);
  assert.equal(supportsReadiness(f.next), false);
  await waitForHealthy(f.config, f.next, '19', f.options);
  assert.deepEqual(f.urls, ['https://deploy.local/', 'https://deploy.local/']);
  mkdirSync(join(f.next, 'server'));
  writeFileSync(join(f.next, 'server/readiness.ts'), '// present in the verified new release');
  assert.equal(supportsReadiness(f.next), true);
  f.urls.length = 0;
  await waitForHealthy(f.config, f.next, '19', f.options);
  assert.deepEqual(f.urls, [
    'https://deploy.local/api/health/ready',
    'https://deploy.local/api/health/ready',
  ]);
});
