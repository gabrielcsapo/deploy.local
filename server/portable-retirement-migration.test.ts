import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

const retiredTables = [
  'site_pairing_codes',
  'site_users',
  'readiness_certificates',
  'data_reconciliation_profiles',
  'data_changesets',
  'blob_references',
  'fleet_telemetry_records',
  'artifact_transfers',
  'app_materialization',
  'volume_snapshots',
  'volume_authority_transfers',
  'portability_reports',
  'suitcase_capacity_plans',
];
const inventoryTables = [
  'data_sync_policies',
  'data_checkpoints',
  'data_conflicts',
  'fleet_events',
  'site_sync_cursors',
  'release_candidates',
];
const retainedTables = ['users', 'deployments', 'fleets', 'sites'];

for (const boundary of [
  '0046_drop_unused_portable_tables',
  '0047_drop_portable_inventory_tables',
  '0048_drop_app_replicas',
]) {
  test(`portable retirement from before ${boundary} preserves retained data and matches a fresh install`, (t) => {
    const droppedTables = boundary.startsWith('0046')
      ? [...retiredTables, ...inventoryTables, 'app_replicas']
      : boundary.startsWith('0047')
        ? [...inventoryTables, 'app_replicas']
        : ['app_replicas'];
    const root = mkdtempSync(join(tmpdir(), 'deploy-portable-retirement-'));
    const upgrade = new Database(join(root, 'upgrade.db'));
    const fresh = new Database(join(root, 'fresh.db'));
    t.after(() => {
      upgrade.close();
      fresh.close();
      rmSync(root, { recursive: true, force: true });
    });
    const migrations = resolve('drizzle');
    const previous = join(root, 'previous');
    mkdirSync(join(previous, 'meta'), { recursive: true });
    const journal = JSON.parse(readFileSync(join(migrations, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string }>;
    };
    const retirement = journal.entries.findIndex((entry) => entry.tag === boundary);
    assert.ok(retirement > 0);
    const entries = journal.entries.slice(0, retirement);
    writeFileSync(join(previous, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    for (const entry of entries) {
      copyFileSync(join(migrations, `${entry.tag}.sql`), join(previous, `${entry.tag}.sql`));
    }
    upgrade.pragma('foreign_keys = ON');
    fresh.pragma('foreign_keys = ON');
    migrate(drizzle(upgrade), { migrationsFolder: previous });

    const beforeSchema = upgrade
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
    for (const table of beforeSchema.filter((item) => item.type === 'table')) {
      const foreignKeys = upgrade.pragma(
        `foreign_key_list(${JSON.stringify(table.name)})`,
      ) as Array<{
        table: string;
      }>;
      assert.equal(
        foreignKeys.some(
          (key) => droppedTables.includes(table.name) || droppedTables.includes(key.table),
        ),
        false,
        `${table.name} must have no foreign key involving a retired table`,
      );
    }

    // Populate both sides of the boundary, including every retired table. Required text/integer
    // fields suffice here: these historical tables have no application-level validation in SQL.
    for (const table of [...droppedTables, ...retainedTables]) {
      const columns = upgrade.pragma(`table_info(${table})`) as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
        dflt_value: unknown;
      }>;
      assert.ok(columns.length, `${table} exists before retirement`);
      const required = columns.filter(
        (column) => column.pk || (column.notnull && column.dflt_value === null),
      );
      upgrade
        .prepare(
          `INSERT INTO ${table} (${required.map((column) => JSON.stringify(column.name)).join(', ')}) VALUES (${required.map(() => '?').join(', ')})`,
        )
        .run(
          ...required.map((column) => (column.type === 'INTEGER' ? 1 : `${table}:${column.name}`)),
        );
    }
    const retainedRows = retainedTables.map((table) =>
      upgrade.prepare(`SELECT * FROM ${table}`).all(),
    );
    migrate(drizzle(upgrade), { migrationsFolder: migrations });
    migrate(drizzle(fresh), { migrationsFolder: migrations });
    const schemaQuery =
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name";
    assert.deepEqual(upgrade.prepare(schemaQuery).all(), fresh.prepare(schemaQuery).all());
    assert.deepEqual(
      upgrade.prepare(schemaQuery).all(),
      beforeSchema.filter((item) => !droppedTables.includes(item.tbl_name)),
      'only the retired tables and their indexes are removed',
    );
    assert.deepEqual(
      retainedTables.map((table) => upgrade.prepare(`SELECT * FROM ${table}`).all()),
      retainedRows,
    );
    for (const database of [upgrade, fresh]) {
      assert.deepEqual(database.pragma('foreign_key_check'), []);
      assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
    }
    // An already upgraded database must not rerun the destructive migration.
    migrate(drizzle(upgrade), { migrationsFolder: migrations });
  });
}
