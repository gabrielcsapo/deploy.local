import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

test('upgrades an existing fleet without changing nodes or default placement', () => {
  const directory = mkdtempSync(join(tmpdir(), 'roles-migration-'));
  const previous = join(directory, 'previous');
  mkdirSync(join(previous, 'meta'), { recursive: true });
  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
  // A coordinator from before this migration has none of it or the migrations after it.
  journal.entries = journal.entries.slice(
    0,
    journal.entries.findIndex((entry: { tag: string }) => entry.tag === '0036_computer_roles'),
  );
  writeFileSync(join(previous, 'meta/_journal.json'), JSON.stringify(journal));
  for (const entry of journal.entries)
    copyFileSync(`drizzle/${entry.tag}.sql`, join(previous, `${entry.tag}.sql`));
  const sqlite = new Database(join(directory, 'deploy.db'));
  try {
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: previous });
    sqlite
      .prepare(
        "INSERT INTO nodes (id,name,kind,enrolled_at,capabilities) VALUES ('fixture','Fixture','agent','2026-01-01','{}')",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO system_settings (key,value,updated_at) VALUES ('default_node_id','fixture','2026-01-01')",
      )
      .run();
    const before = sqlite.prepare('SELECT * FROM nodes').all();
    migrate(db, { migrationsFolder: resolve('drizzle') });
    assert.deepEqual(sqlite.prepare('SELECT * FROM nodes').all(), before);
    assert.deepEqual(sqlite.prepare('SELECT * FROM computer_role_preferences').all(), []);
    assert.equal(
      (sqlite.prepare("SELECT value FROM system_settings WHERE key='default_node_id'").get() as any)
        .value,
      'fixture',
    );
    migrate(db, { migrationsFolder: resolve('drizzle') });
    sqlite
      .prepare('INSERT INTO computer_role_preferences (id,roles) VALUES (?,?)')
      .run('fixture', '{"deploy":false}');
    assert.equal(
      (sqlite.prepare('SELECT roles FROM computer_role_preferences').get() as any).roles,
      '{"deploy":false}',
    );
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
