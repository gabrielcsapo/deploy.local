import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { launcherEligible, runLauncher } from './launcher.mjs';
import {
  installCodeBundle,
  bundleDigest,
  readCurrentBundle,
  pruneCodeBundles,
} from './code-bundle.mjs';
import { buildCliManifest, bundleCli, convertCliToCommonJS } from '../scripts/build-cli.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'launcher-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    delete globalThis.deployLauncherBuild;
  });
  return root;
}
function install(root, version, text = 'module.exports = async () => {};') {
  const bytes = Buffer.from(text);
  return installCodeBundle({
    agentDir: root,
    bytes,
    size: bytes.length,
    sha256: bundleDigest(bytes),
    version,
    launcherProtocol: 1,
    executableProtocol: 1,
  });
}
for (const failure of [
  'absent',
  'missing file',
  'wrong hash',
  'unsupported protocol',
  'throws at load',
])
  test(`bootstrap falls back and records ${failure}`, async (t) => {
    const root = fixture(t);
    if (failure !== 'absent') {
      const pointer = install(
        root,
        'new',
        failure === 'throws at load' ? 'throw new Error("load failed");' : undefined,
      );
      if (failure === 'missing file') rmSync(join(root, 'code', pointer.file));
      if (failure === 'wrong hash') writeFileSync(join(root, 'code', pointer.file), 'wrong');
      if (failure === 'unsupported protocol')
        writeFileSync(
          join(root, 'code/current.json'),
          JSON.stringify({ ...pointer, launcherProtocol: 2 }),
        );
    }
    let fallback = 0;
    await runLauncher({
      agentDir: root,
      eligible: true,
      build: { version: 'baked' },
      baked: async () => fallback++,
    });
    assert.equal(fallback, 1);
    const receipt = JSON.parse(readFileSync(join(root, 'data/code-bundle.json')));
    assert.match(
      receipt.reason,
      {
        absent: /No installed/,
        'missing file': /ENOENT/,
        'wrong hash': /SHA-256/,
        'unsupported protocol': /Unsupported/,
        'throws at load': /load failed/,
      }[failure],
    );
    assert.equal(statSync(join(root, 'data/code-bundle.json')).mode & 0o777, 0o600);
  });

test('a bundle that fails after it started is not run again from the built-in code', async (t) => {
  // Once the entry has been called it may have done work; a second run would repeat it.
  const root = fixture(t);
  install(root, 'new', 'module.exports = async () => { throw new Error("entry failed"); };');
  let fallback = 0;
  await assert.rejects(
    runLauncher({
      agentDir: root,
      eligible: true,
      build: { version: 'baked' },
      baked: async () => fallback++,
    }),
    /entry failed/,
  );
  assert.equal(fallback, 0);
});

test('only a worker executable runs an installed bundle; the deploy command runs its own code', async (t) => {
  const root = fixture(t);
  install(root, 'new', 'module.exports = async () => { throw new Error("bundle ran"); };');
  for (const name of ['deploy', 'deploy-darwin-arm64', 'node']) {
    let baked = 0;
    await runLauncher({
      agentDir: root,
      filename: join(root, 'bin', name),
      eligible: launcherEligible(join(root, 'bin', name), {}),
      build: { version: 'baked' },
      baked: async () => baked++,
    });
    assert.equal(baked, 1, name);
  }
  for (const name of ['deploy-worker', 'deploy-worker-supervisor', 'worker', 'worker-supervisor'])
    assert.equal(launcherEligible(join(root, name), {}), true, name);
  assert.equal(launcherEligible(join(root, 'deploy'), { DEPLOY_WORKER_CHILD: 'token' }), true);
});

test('disk bundle uses absolute createRequire, unchanged argv and SEA filename semantics', async (t) => {
  const root = fixture(t);
  const source = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(root, 'result.json'))}, JSON.stringify({ file: import.meta.url, dir: import.meta.dirname, argv: process.argv, executable: globalThis.deployLauncherBuild }));`;
  install(root, 'new', convertCliToCommonJS(source));
  const filename = join(root, 'Worker.app/Contents/MacOS/deploy-worker');
  const before = [...process.argv];
  await runLauncher({
    agentDir: root,
    filename,
    build: { version: 'baked' },
    baked: () => assert.fail('fallback'),
  });
  const result = JSON.parse(readFileSync(join(root, 'result.json')));
  assert.deepEqual(result.argv, before);
  assert.equal(result.file, 'file://' + filename);
  assert.equal(result.dir, dirname(filename));
  assert.equal(result.executable.version, 'baked');
  assert.equal(result.executable.launcherProtocol, 1);
});

test('bundle storage is private, retains current and previous, and rejects corrupt or incompatible downloads', (t) => {
  const root = fixture(t);
  install(root, 'one');
  install(root, 'two');
  install(root, 'three');
  pruneCodeBundles(root);
  assert.deepEqual(readdirSync(join(root, 'code')).sort(), [
    'current.json',
    'previous.json',
    'three',
    'two',
  ]);
  assert.equal(readCurrentBundle(root).version, 'three');
  for (const path of ['code', 'code/three', 'code/two'])
    assert.equal(statSync(join(root, path)).mode & 0o777, 0o700);
  for (const path of ['code/current.json', 'code/previous.json', 'code/three/deploy.cjs'])
    assert.equal(statSync(join(root, path)).mode & 0o777, 0o600);
  const bytes = Buffer.from('new');
  const options = {
    agentDir: root,
    version: 'four',
    bytes,
    size: bytes.length,
    sha256: bundleDigest(bytes),
    launcherProtocol: 1,
    executableProtocol: 1,
  };
  assert.throws(() => installCodeBundle({ ...options, sha256: '0'.repeat(64) }), /checksum/);
  assert.throws(() => installCodeBundle({ ...options, size: 100 }), /checksum/);
  assert.throws(() => installCodeBundle({ ...options, executableProtocol: 0 }), /protocol/);
  assert.throws(() => installCodeBundle({ ...options, version: '../escape' }), /version/);
  assert.equal(readCurrentBundle(root).version, 'three');
});

test('manifest carries code identity and the launcher runs baked and installed builds without a SEA build', async (t) => {
  const root = fixture(t);
  const build = { version: 'baked-test', packageVersion: '1.0.0', commit: 'unknown' };
  await bundleCli(build, root);
  const manifest = buildCliManifest(build, root);
  const bytes = readFileSync(join(root, 'deploy.cjs'));
  assert.deepEqual(manifest.bundle, {
    file: 'deploy.cjs',
    version: build.version,
    launcherProtocol: 1,
    size: bytes.length,
    sha256: bundleDigest(bytes),
    restartSupervisor: false,
  });
  assert.equal(
    buildCliManifest(build, root, { restartSupervisor: true }).bundle.restartSupervisor,
    true,
  );
  const probe = () =>
    spawnSync(process.execPath, [join(root, 'launcher.cjs'), 'version', '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        // Mark this ordinary Node process as a worker's, as the supervisor does for its child.
        DEPLOY_WORKER_CHILD: 'test',
        DEPLOY_AGENT_CONFIG: join(root, 'agent.json'),
        DEPLOY_DATA_DIR: join(root, 'data'),
        DEPLOY_MDNS_ADDRESS: '127.0.0.1',
      },
    });
  const baked = probe();
  assert.equal(baked.status, 0, baked.stderr);
  assert.equal(JSON.parse(baked.stdout).executable.version, build.version);
  const output = join(root, 'next');
  await bundleCli({ ...build, version: 'next' }, output);
  install(root, 'next', readFileSync(join(output, 'deploy.cjs'), 'utf8'));
  const updated = probe();
  assert.equal(updated.status, 0, updated.stderr);
  const info = JSON.parse(updated.stdout);
  assert.equal(info.version, 'next');
  assert.equal(info.code.version, 'next');
  assert.equal(info.executable.version, build.version);
  assert.equal(info.launcherProtocol, 1);
});
