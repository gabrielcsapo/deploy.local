import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = await mkdtemp(join(tmpdir(), 'v2-start-test-'));
process.env.DEPLOY_DATA_DIR = join(root, 'data');
const { inspectRepository } = await import('./start.ts');
const { db } = await import('../workspace/store.ts');
test.after(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});
test('repository preview reads committed app and data requirements without running scripts', async () => {
  execFileSync('git', ['init', root]);
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'home-gym',
      scripts: { build: 'vite build', start: 'node dist/server.js', postinstall: 'exit 99' },
    }),
  );
  await writeFile(join(root, 'compose.yaml'), 'services:\n  database:\n    image: postgres:17\n');
  execFileSync('git', ['-C', root, 'add', 'package.json', 'compose.yaml']);
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'fixture',
  ]);
  const before = await readdir(root);
  const result = await inspectRepository(root);
  assert.deepEqual(result.found, [
    { name: 'home-gym', detail: 'vite build · node dist/server.js' },
    { name: 'database', detail: 'postgres:17 · from compose.yaml' },
  ]);
  assert.deepEqual(await readdir(root), before);
  assert.equal(result.runsOn, 'Choose when you ship');
  await assert.rejects(inspectRepository('--upload-pack=bad'), /absolute server path/);
  await assert.rejects(inspectRepository('file:///etc/passwd'), /HTTP/);
});
