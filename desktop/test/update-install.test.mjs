import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { appBundle, returnPage, readHandoff, acknowledgeStart } from '../src/update-install.mjs';

test('bundle detection and return page never navigate to another coordinator', () => {
  assert.equal(appBundle('/tmp/A place/Test.app/Contents/MacOS/Test'), '/tmp/A place/Test.app');
  assert.throws(() => appBundle('/usr/bin/electron'));
  const origin = 'http://127.0.0.1:5194';
  assert.equal(
    returnPage(origin + '/dashboard/projects/x/code?a=1#L2', origin),
    '/dashboard/projects/x/code?a=1#L2',
  );
  for (const page of ['https://example.com/dashboard', origin + '/api/delete', 'file:///tmp/a'])
    assert.equal(returnPage(page, origin), '/dashboard');
});
async function setup(t, behavior) {
  const root = await mkdtemp(join(tmpdir(), 'swap-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = '12345678-1234-1234-1234-123456789abc';
  const bundle = join(root, "An app's name.app");
  const candidate = join(root, 'candidate.app');
  const backup = join(root, `.${"An app's name.app"}.previous-${token}.app`);
  await mkdir(bundle);
  await mkdir(candidate);
  await mkdir(join(root, 'updates'));
  await writeFile(join(bundle, 'identity'), 'old');
  await writeFile(join(candidate, 'identity'), 'new');
  const receipt = join(root, 'updates', token + '.json');
  const build = { commit: 'new', buildTime: '2026-11-01T00:00:00Z' };
  await writeFile(
    receipt,
    JSON.stringify({
      bundle,
      candidate,
      backup,
      page: 'http://127.0.0.1:5194/dashboard/projects',
      build,
    }),
  );
  const launcher = join(root, 'launcher.sh');
  await writeFile(launcher, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${root}/launches"\n${behavior}\n`, {
    mode: 0o700,
  });
  const start = (pid = '99999999') => {
    const child = spawn(
      '/bin/sh',
      [
        fileURLToPath(new URL('../src/update-helper.sh', import.meta.url)),
        String(pid),
        bundle,
        candidate,
        backup,
        receipt,
        token,
        root,
        launcher,
        '2',
      ],
      { stdio: 'pipe' },
    );
    return once(child, 'exit');
  };
  return { root, token, bundle, candidate, backup, receipt, build, start };
}
test('helper waits for exit, swaps bundles with quoted paths and retains backup without an acknowledgement', async (t) => {
  const f = await setup(t, 'exit 0');
  const [code] = await f.start();
  assert.equal(code, 1);
  assert.equal(await readFile(join(f.bundle, 'identity'), 'utf8'), 'old');
  assert.equal(await readFile(join(f.candidate + '.failed', 'identity'), 'utf8'), 'new');
  assert.match(await readFile(join(f.root, 'launches'), 'utf8'), /--deploy-update-rollback=/);
});
test('helper restores old bundle when the replacement is missing or launch fails', async (t) => {
  for (const missing of [true, false]) {
    const f = await setup(t, 'exit 1');
    if (missing) await rm(f.candidate, { recursive: true });
    const [code] = await f.start();
    assert.equal(code, 1);
    assert.equal(await readFile(join(f.bundle, 'identity'), 'utf8'), 'old');
  }
});
test('new app acknowledges only its own build and removes backup after startup', async (t) => {
  const f = await setup(t, 'exit 0');
  // Use a launcher that models the startup acknowledgement; the real reader is tested below.
  await writeFile(
    join(f.root, 'launcher.sh'),
    `#!/bin/sh\nmkdir "$DEPLOY_TEST_RECEIPT.claim"\necho started > "$DEPLOY_TEST_RECEIPT.ok"\n`,
    { mode: 0o700 },
  );
  const previous = process.env.DEPLOY_TEST_RECEIPT;
  process.env.DEPLOY_TEST_RECEIPT = f.receipt;
  try {
    assert.equal((await f.start())[0], 0);
    assert.equal(await readFile(join(f.bundle, 'identity'), 'utf8'), 'new');
    assert.equal(await readFile(join(f.backup, 'identity'), 'utf8'), 'old');
    await rm(f.receipt + '.claim', { recursive: true });
    await rm(f.receipt + '.ok');
    const input = {
      args: ['--deploy-update=' + f.token],
      directory: f.root,
      executable: f.bundle + '/Contents/MacOS/Test',
      build: f.build,
    };
    assert.throws(() => readHandoff({ ...input, build: { commit: 'wrong' } }), /does not match/);
    const handoff = readHandoff(input);
    assert.equal(await acknowledgeStart(handoff), true);
    await assert.rejects(access(f.backup));
    assert.equal(await readFile(f.receipt + '.ok', 'utf8'), 'started\n');
  } finally {
    if (previous === undefined) delete process.env.DEPLOY_TEST_RECEIPT;
    else process.env.DEPLOY_TEST_RECEIPT = previous;
  }
});
test('a timed out new process cannot acknowledge over rollback', async (t) => {
  const f = await setup(t, 'exit 0');
  await mkdir(f.receipt + '.claim');
  assert.equal(await acknowledgeStart({ receipt: f.receipt, backup: f.backup }), false);
});

test('helper does not rename the running bundle before its process exits', async (t) => {
  const f = await setup(t, 'exit 1');
  const running = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  t.after(() => {
    if (running.exitCode === null) running.kill();
  });
  await once(running, 'spawn');
  const completion = f.start(running.pid);
  await setTimeout(100);
  assert.equal(await readFile(join(f.bundle, 'identity'), 'utf8'), 'old');
  await assert.rejects(access(f.backup));
  const stopped = once(running, 'exit');
  running.kill();
  await stopped;
  assert.equal((await completion)[0], 1);
  assert.equal(await readFile(join(f.bundle, 'identity'), 'utf8'), 'old');
});
