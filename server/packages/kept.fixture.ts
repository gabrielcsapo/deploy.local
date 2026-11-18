import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

export async function keptFixture() {
  const root = await mkdtemp(join(tmpdir(), 'kept-test-'));
  process.env.DEPLOY_DATA_DIR = root;
  await import('../test-backups.ts');
  const { registerUser, _resetDb } = await import('../store.ts');
  const { db, objectPath } = await import('./store.ts');
  const { db: workspaceDb, save } = await import('../workspace/store.ts');
  registerUser('owner', 'test-long-password');
  registerUser('reader', 'test-long-password');
  db().prepare("UPDATE users SET role='admin' WHERE username='owner'").run();
  save('project', 'owner', { id: 'p1', name: 'forma' });
  save('project', 'owner', { id: 'p2', name: 'wander' });
  const clock = Date.parse('2026-11-14T12:00:00Z');
  async function add(
    name: string,
    version = '1.0.0',
    ecosystem = 'npm',
    size = 100,
    days = 40,
    hash?: string,
  ) {
    const key = `${name}@${version}`;
    const sha256 =
      hash ||
      createHash('sha256')
        .update(ecosystem + key)
        .digest('hex');
    const path = objectPath('cache', sha256);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'copy');
    const date = new Date(clock - days * 86400000).toISOString();
    db()
      .prepare(
        "INSERT INTO package_cache_entries(ecosystem,kind,key,sha256,size,fetched_at,last_used_at) VALUES(?,'file',?,?,?,?,?)",
      )
      .run(ecosystem, key, sha256, size, date, date);
    return { key, sha256, path };
  }
  function reset() {
    for (const table of ['package_cache_entries', 'package_project_requirements', 'package_pins'])
      db().prepare(`DELETE FROM ${table}`).run();
  }
  async function close() {
    _resetDb();
    workspaceDb.close();
    await rm(root, { recursive: true, force: true });
  }
  return { root, db, add, reset, close, clock };
}
