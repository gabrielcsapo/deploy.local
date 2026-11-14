import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'jobs-kernel-'));
process.env.DEPLOY_DATA_DIR = root;
after(async () => {
  (await import('./workspace/store.ts')).db.close();
  rmSync(root, { recursive: true, force: true });
});

test('old and new job paths expose identical functions', async () => {
  for (const name of ['worker-lease', 'remote-worker-lease', 'service-loop', 'repository-lock']) {
    const old = await import(`./workspace/${name}.ts`);
    const current = await import(`./kernel/jobs/${name}.ts`);
    assert.deepEqual(Object.keys(old), Object.keys(current));
    for (const key of Object.keys(old)) assert.equal(old[key], current[key], `${name}: ${key}`);
  }
});

test('unregistered process adapter refuses even an explicit remote lease before writing', () => {
  const path = join(root, 'unregistered.pid');
  execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    import { claimRemoteWorker } from ${JSON.stringify(new URL('./kernel/jobs/remote-worker-lease.ts', import.meta.url).href)};
    import { workerLease, stopStaleWorker } from ${JSON.stringify(new URL('./kernel/jobs/worker-lease-process.ts', import.meta.url).href)};
    const lease = {pid:process.pid, executablePath:process.execPath, entryPath:'test', build:{version:'test'}};
    for (const call of [workerLease, () => stopStaleWorker(2, lease), () => claimRemoteWorker(${JSON.stringify(path)}, lease)])
      assert.throws(call, {message:'Worker lease process adapter not registered'});
  `,
  ]);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(path + '.claim'), false);
});

test('existing recursive kernel guard covers jobs, and every worker entry reaches registration', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.match(source('./kernel-imports.test.ts'), /walk\(kernel\)/);
  for (const entry of ['repository-worker', 'pipeline-worker', 'worker', 'remote-worker']) {
    const seen = new Set<string>();
    function visit(url: URL) {
      if (seen.has(url.href)) return;
      seen.add(url.href);
      for (const match of readFileSync(url, 'utf8').matchAll(
        /(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g,
      )) {
        const target = new URL(match[1], url);
        if (target.pathname.endsWith('.ts') && target.pathname.includes('/server/')) visit(target);
      }
    }
    visit(new URL(`./workspace/${entry}.ts`, import.meta.url));
    for (const dependency of [
      'workspace/worker-process.ts',
      'kernel/jobs/worker-lease-process.ts',
      `kernel/jobs/${entry === 'remote-worker' ? 'remote-worker-lease' : 'worker-lease'}.ts`,
    ])
      assert.ok(
        seen.has(new URL(`./${dependency}`, import.meta.url).href),
        `${entry}: ${dependency}`,
      );
  }
});
