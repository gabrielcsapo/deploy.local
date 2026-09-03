import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('v1 database migration', () => {
  it('upgrades a pre-v1 database without losing existing deployments', () => {
    const workspaceMigrations = resolve(process.cwd(), 'drizzle');
    const directory = mkdtempSync(join(tmpdir(), 'deploy-v1-migration-'));
    temporaryDirectories.push(directory);
    const previousMigrations = join(directory, 'previous-migrations');
    const previousMeta = join(previousMigrations, 'meta');
    mkdirSync(previousMeta, { recursive: true });

    const journal = JSON.parse(
      readFileSync(join(workspaceMigrations, 'meta', '_journal.json'), 'utf8'),
    ) as {
      version: string;
      dialect: string;
      entries: Array<{ idx: number; tag: string }>;
    };
    const previousJournal = {
      ...journal,
      entries: journal.entries.filter((entry) => entry.idx < 24),
    };
    writeFileSync(
      join(previousMeta, '_journal.json'),
      `${JSON.stringify(previousJournal, null, 2)}\n`,
    );
    for (const entry of previousJournal.entries) {
      copyFileSync(
        join(workspaceMigrations, `${entry.tag}.sql`),
        join(previousMigrations, `${entry.tag}.sql`),
      );
    }

    const sqlite = new Database(join(directory, 'deploy.db'));
    try {
      const db = drizzle(sqlite);
      migrate(db, { migrationsFolder: previousMigrations });
      sqlite
        .prepare(
          `INSERT INTO deployments
             (name, username, port, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          'family-dashboard',
          'alice',
          43123,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        );

      migrate(db, { migrationsFolder: workspaceMigrations });

      const deployment = sqlite
        .prepare(
          `SELECT name, username, port, desired_spec_digest, active_spec_digest,
                  configuration_digest, spec_source
             FROM deployments
            WHERE name = ?`,
        )
        .get('family-dashboard');
      assert.deepEqual(deployment, {
        name: 'family-dashboard',
        username: 'alice',
        port: 43123,
        desired_spec_digest: null,
        active_spec_digest: null,
        configuration_digest: null,
        spec_source: null,
      });

      const tables = new Set(
        (
          sqlite
            .prepare(
              `SELECT name FROM sqlite_master
                WHERE type = 'table' AND name LIKE 'application_%'`,
            )
            .all() as Array<{ name: string }>
        ).map((row) => row.name),
      );
      for (const table of [
        'application_configuration_values',
        'application_spec_revisions',
        'application_spec_transitions',
      ]) {
        assert.equal(tables.has(table), true, `${table} must exist after migration`);
      }
    } finally {
      sqlite.close();
    }
  });

  it('upgrades a pre-0031 database with writer handoffs, profile bindings, and fleet telemetry', () => {
    const workspaceMigrations = resolve(process.cwd(), 'drizzle');
    const directory = mkdtempSync(join(tmpdir(), 'deploy-0031-migration-'));
    temporaryDirectories.push(directory);
    const previousMigrations = join(directory, 'previous-migrations');
    const previousMeta = join(previousMigrations, 'meta');
    mkdirSync(previousMeta, { recursive: true });
    const journal = JSON.parse(
      readFileSync(join(workspaceMigrations, 'meta', '_journal.json'), 'utf8'),
    ) as {
      version: string;
      dialect: string;
      entries: Array<{ idx: number; tag: string }>;
    };
    const previousJournal = {
      ...journal,
      entries: journal.entries.filter((entry) => entry.idx < 31),
    };
    writeFileSync(
      join(previousMeta, '_journal.json'),
      `${JSON.stringify(previousJournal, null, 2)}\n`,
    );
    for (const entry of previousJournal.entries) {
      copyFileSync(
        join(workspaceMigrations, `${entry.tag}.sql`),
        join(previousMigrations, `${entry.tag}.sql`),
      );
    }

    const sqlite = new Database(join(directory, 'deploy.db'));
    try {
      const db = drizzle(sqlite);
      migrate(db, { migrationsFolder: previousMigrations });
      migrate(db, { migrationsFolder: workspaceMigrations });
      const tables = new Set(
        (
          sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
            name: string;
          }>
        ).map((row) => row.name),
      );
      assert.equal(tables.has('volume_authority_transfers'), true);
      assert.equal(tables.has('component_profile_volume_bindings'), true);
      assert.equal(tables.has('fleet_telemetry_records'), true);
      assert.equal(tables.has('component_site_overrides'), true);
      const columns = new Set(
        (
          sqlite.prepare('PRAGMA table_info(component_profile_operations)').all() as Array<{
            name: string;
          }>
        ).map((column) => column.name),
      );
      for (const column of [
        'artifact_media_type',
        'source_spec_digest',
        'target_spec_digest',
        'source_volume',
        'target_volume',
        'rollback_volume',
        'evidence',
      ]) {
        assert.equal(columns.has(column), true, `${column} must exist after migration 0031`);
      }
      const indexes = new Set(
        (
          sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
            name: string;
          }>
        ).map((row) => row.name),
      );
      assert.equal(indexes.has('idx_volume_authority_transfers_one_active_app'), true);
      assert.equal(indexes.has('idx_fleet_telemetry_origin_sequence'), true);

      const revisionColumns = new Set(
        (
          sqlite.prepare('PRAGMA table_info(application_spec_revisions)').all() as Array<{
            name: string;
          }>
        ).map((column) => column.name),
      );
      assert.equal(revisionColumns.has('original_artifact_digest'), true);
      assert.equal(revisionColumns.has('normalized_artifact_digest'), true);

      const placementColumns = new Set(
        (
          sqlite.prepare('PRAGMA table_info(component_placements)').all() as Array<{
            name: string;
          }>
        ).map((column) => column.name),
      );
      for (const column of [
        'default_instances',
        'minimum_ready',
        'rollout_strategy',
        'max_surge',
        'max_unavailable',
        'placement_intent',
        'capacity',
      ]) {
        assert.equal(
          placementColumns.has(column),
          true,
          `${column} must exist after migration 0034`,
        );
      }
    } finally {
      sqlite.close();
    }
  });
});
