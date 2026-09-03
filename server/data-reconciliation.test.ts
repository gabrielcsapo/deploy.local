import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';

let root: string;
let store: typeof import('./store.ts');
let reconciliation: typeof import('./data-reconciliation.ts');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-reconcile-'));
  process.env.DEPLOY_DATA_DIR = join(root, 'control');
  store = await import(`./store.ts?reconcile=${Date.now()}`);
  reconciliation = await import(`./data-reconciliation.ts?reconcile=${Date.now()}`);
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

function createNotesDatabase(path: string, rows: Array<[string, string]>) {
  const database = new Database(path);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE notes (
      id TEXT PRIMARY KEY NOT NULL,
      body TEXT NOT NULL
    ) STRICT;
  `);
  const insert = database.prepare('INSERT INTO notes (id, body) VALUES (?, ?)');
  for (const row of rows) insert.run(...row);
  database.close();
}

function noteRows(path: string): Array<{ id: string; body: string }> {
  const database = new Database(path, { readonly: true });
  try {
    return database.prepare('SELECT id, body FROM notes ORDER BY id').all() as Array<{
      id: string;
      body: string;
    }>;
  } finally {
    database.close();
  }
}

describe('SQLite three-way reconciliation', () => {
  it('merges independent branches and then a second suitcase from the older base', () => {
    const base = join(root, 'base.db');
    const home = join(root, 'home.db');
    const suitcaseA = join(root, 'suitcase-a.db');
    const suitcaseB = join(root, 'suitcase-b.db');
    const mergedA = join(root, 'merged-a.db');
    const mergedB = join(root, 'merged-b.db');
    createNotesDatabase(base, [['base', 'shared']]);
    copyFileSync(base, home);
    copyFileSync(base, suitcaseA);
    copyFileSync(base, suitcaseB);
    const homeDb = new Database(home);
    homeDb.prepare('INSERT INTO notes VALUES (?, ?)').run('home', 'created at home');
    homeDb.close();
    const suitcaseADb = new Database(suitcaseA);
    suitcaseADb.prepare('INSERT INTO notes VALUES (?, ?)').run('away-a', 'created on A');
    suitcaseADb.close();
    const suitcaseBDb = new Database(suitcaseB);
    suitcaseBDb.prepare('INSERT INTO notes VALUES (?, ?)').run('away-b', 'created on B');
    suitcaseBDb.close();

    const first = reconciliation.reconcileSqliteDatabases({
      basePath: base,
      homePath: home,
      suitcasePath: suitcaseA,
      outputPath: mergedA,
    });
    assert.equal(first.status, 'merged');
    assert.deepEqual(
      noteRows(mergedA).map((row) => row.id),
      ['away-a', 'base', 'home'],
    );

    const second = reconciliation.reconcileSqliteDatabases({
      basePath: base,
      homePath: mergedA,
      suitcasePath: suitcaseB,
      outputPath: mergedB,
    });
    assert.equal(second.status, 'merged');
    assert.deepEqual(
      noteRows(mergedB).map((row) => row.id),
      ['away-a', 'away-b', 'base', 'home'],
    );
  });

  it('preserves both row versions as unresolved evidence instead of publishing a merge', () => {
    const base = join(root, 'conflict-base.db');
    const home = join(root, 'conflict-home.db');
    const suitcase = join(root, 'conflict-suitcase.db');
    const output = join(root, 'must-not-exist.db');
    createNotesDatabase(base, [['same', 'base value']]);
    copyFileSync(base, home);
    copyFileSync(base, suitcase);
    const homeDb = new Database(home);
    homeDb.prepare('UPDATE notes SET body = ? WHERE id = ?').run('home value', 'same');
    homeDb.close();
    const suitcaseDb = new Database(suitcase);
    suitcaseDb.prepare('UPDATE notes SET body = ? WHERE id = ?').run('suitcase value', 'same');
    suitcaseDb.close();

    const result = reconciliation.reconcileSqliteDatabases({
      basePath: base,
      homePath: home,
      suitcasePath: suitcase,
      outputPath: output,
    });
    assert.equal(result.status, 'conflicted');
    assert.equal(result.outputPath, undefined);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0]?.kind, 'sqlite-row');
    const values = JSON.stringify(result.conflicts[0]);
    assert.match(values, /home value/);
    assert.match(values, /suitcase value/);

    const conflict = result.conflicts[0]!;
    const resolved = reconciliation.reconcileSqliteDatabases({
      basePath: base,
      homePath: home,
      suitcasePath: suitcase,
      outputPath: output,
      conflictResolutions: {
        [`${conflict.kind}:${conflict.logicalAddress}`]: 'suitcase',
      },
    });
    assert.equal(resolved.status, 'merged');
    assert.deepEqual(noteRows(output), [{ id: 'same', body: 'suitcase value' }]);
  });

  it('blocks schema drift before applying any rows', () => {
    const base = join(root, 'schema-base.db');
    const home = join(root, 'schema-home.db');
    const suitcase = join(root, 'schema-suitcase.db');
    createNotesDatabase(base, []);
    copyFileSync(base, home);
    copyFileSync(base, suitcase);
    const suitcaseDb = new Database(suitcase);
    suitcaseDb.exec('ALTER TABLE notes ADD COLUMN title TEXT');
    suitcaseDb.close();
    const result = reconciliation.reconcileSqliteDatabases({
      basePath: base,
      homePath: home,
      suitcasePath: suitcase,
      outputPath: join(root, 'schema-output.db'),
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.conflicts[0]?.kind, 'schema');
  });

  it('encodes only profile-admitted tables in the native session changeset', () => {
    const base = join(root, 'profile-base.db');
    const branch = join(root, 'profile-branch.db');
    const artifactPath = join(root, 'profile.changeset');
    const materialized = join(root, 'profile-materialized.db');
    createNotesDatabase(base, [['note', 'base note']]);
    const baseDatabase = new Database(base);
    baseDatabase.exec(
      'CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT',
    );
    baseDatabase.prepare('INSERT INTO sessions VALUES (?, ?)').run('session', 'base session');
    baseDatabase.close();
    copyFileSync(base, branch);
    const branchDatabase = new Database(branch);
    branchDatabase.prepare('UPDATE notes SET body = ? WHERE id = ?').run('away note', 'note');
    branchDatabase
      .prepare('UPDATE sessions SET value = ? WHERE id = ?')
      .run('away session', 'session');
    branchDatabase.close();

    const artifact = reconciliation.createSqliteChangesetArtifact(base, branch, {
      includedTables: ['notes'],
    });
    writeFileSync(artifactPath, artifact.bytes);
    reconciliation.materializeSqliteChangeset({
      basePath: base,
      changesetPath: artifactPath,
      outputPath: materialized,
      expectedSchemaFingerprint: artifact.schemaFingerprint,
    });
    const result = new Database(materialized, { readonly: true });
    assert.equal(
      (result.prepare('SELECT body FROM notes WHERE id = ?').get('note') as { body: string }).body,
      'away note',
    );
    assert.equal(
      (
        result.prepare('SELECT value FROM sessions WHERE id = ?').get('session') as {
          value: string;
        }
      ).value,
      'base session',
    );
    result.close();
  });

  it('fails closed when SQLite cannot replay a unique-value swap losslessly', () => {
    const base = join(root, 'unique-swap-base.db');
    const branch = join(root, 'unique-swap-branch.db');
    const database = new Database(base);
    database.exec(
      'CREATE TABLE accounts (id TEXT PRIMARY KEY NOT NULL, alias TEXT NOT NULL UNIQUE) STRICT',
    );
    database.prepare('INSERT INTO accounts VALUES (?, ?)').run('one', 'alpha');
    database.prepare('INSERT INTO accounts VALUES (?, ?)').run('two', 'beta');
    database.close();
    copyFileSync(base, branch);
    const edited = new Database(branch);
    edited.exec(
      "UPDATE accounts SET alias = 'temporary' WHERE id = 'one'; UPDATE accounts SET alias = 'alpha' WHERE id = 'two'; UPDATE accounts SET alias = 'beta' WHERE id = 'one'",
    );
    edited.close();

    assert.throws(
      () => reconciliation.createSqliteChangesetArtifact(base, branch),
      /could not replay this branch changeset losslessly/,
    );
    const stillIntact = new Database(branch, { readonly: true });
    assert.deepEqual(stillIntact.prepare('SELECT id, alias FROM accounts ORDER BY id').all(), [
      { id: 'one', alias: 'beta' },
      { id: 'two', alias: 'alpha' },
    ]);
    stillIntact.close();
  });
});

describe('uploaded-file three-way reconciliation', () => {
  it('unions independent uploads and keeps both versions on a same-path collision', async () => {
    const baseRoot = join(root, 'files-base');
    const homeRoot = join(root, 'files-home');
    const suitcaseRoot = join(root, 'files-suitcase');
    mkdirSync(baseRoot);
    mkdirSync(homeRoot);
    mkdirSync(suitcaseRoot);
    writeFileSync(join(baseRoot, 'shared.txt'), 'base');
    writeFileSync(join(homeRoot, 'shared.txt'), 'home');
    writeFileSync(join(homeRoot, 'home.txt'), 'created at home');
    writeFileSync(join(suitcaseRoot, 'shared.txt'), 'suitcase');
    writeFileSync(join(suitcaseRoot, 'away.txt'), 'created away');
    const base = await reconciliation.createFileManifestAsync(baseRoot);
    const home = await reconciliation.createFileManifestAsync(homeRoot);
    const suitcase = await reconciliation.createFileManifestAsync(suitcaseRoot);
    const result = reconciliation.reconcileFileManifests({
      base,
      home,
      suitcase,
      suitcaseSiteId: 'suitcase-a',
    });

    assert.equal(result.status, 'conflicted');
    assert.equal(result.conflicts.length, 1);
    assert.ok(result.manifest.entries['home.txt']);
    assert.ok(result.manifest.entries['away.txt']);
    assert.equal(result.conflictCopies.length, 1);
    const output = join(root, 'files-merged');
    reconciliation.materializeFileManifest(result.manifest, output);
    assert.equal(readFileSync(join(output, 'shared.txt'), 'utf8'), 'home');
    assert.equal(
      readFileSync(join(output, result.conflictCopies[0]!.preservedPath), 'utf8'),
      'suitcase',
    );

    const conflict = result.conflicts[0]!;
    const resolved = reconciliation.reconcileFileManifests({
      base,
      home,
      suitcase,
      suitcaseSiteId: 'suitcase-a',
      conflictResolutions: {
        [`${conflict.kind}:${conflict.logicalAddress}`]: 'keep-both',
      },
    });
    assert.equal(resolved.status, 'merged');
    assert.equal(resolved.conflictCopies.length, 1);
  });
});

describe('data policy and checkpoint lifecycle', () => {
  it('defaults to no data sync and gates manual mode until Sync now', () => {
    assert.deepEqual(reconciliation.getDataSyncPolicy('app-policy', 'site-a'), {
      policy: 'none',
      conflictPolicy: 'collect',
      source: 'safe-default',
    });
    assert.throws(() => reconciliation.assertSyncAllowed('app-policy', 'site-a'), /disabled/);
    reconciliation.setDataSyncPolicy({
      appId: 'app-policy',
      siteId: 'site-a',
      policy: 'manual',
      updatedBy: 'admin',
    });
    assert.throws(() => reconciliation.assertSyncAllowed('app-policy', 'site-a'), /Sync now/);
    assert.doesNotThrow(() => reconciliation.assertSyncAllowed('app-policy', 'site-a', true));
  });

  it('creates a verified immutable checkpoint and blob reference inventory', async () => {
    const databasePath = join(root, 'checkpoint.db');
    const filesRoot = join(root, 'checkpoint-files');
    createNotesDatabase(databasePath, [['one', 'checkpoint']]);
    mkdirSync(filesRoot);
    writeFileSync(join(filesRoot, 'upload.txt'), 'uploaded');
    const checkpoint = await reconciliation.createDataCheckpoint({
      appId: 'app-checkpoint',
      originSiteId: 'site-home',
      databasePath,
      filesRoot,
      schemaFingerprint: 'sha256:schema',
      profileVersion: 'sha256:profile',
    });
    const record = store
      .getSqlite()!
      .prepare('SELECT verification_status FROM data_checkpoints WHERE id = ?')
      .get(checkpoint.id) as { verification_status: string };
    assert.equal(record.verification_status, 'verified');
    assert.deepEqual(reconciliation.checkpointStats(checkpoint.id), {
      logicalBytes: 8,
      files: 1,
      blobs: 1,
    });
  });

  it('publishes a changeset only after staging and checkpoint validation', async () => {
    const basePath = join(root, 'flow-base.db');
    const homePath = join(root, 'flow-home.db');
    const suitcasePath = join(root, 'flow-suitcase.db');
    createNotesDatabase(basePath, [['base', 'shared']]);
    copyFileSync(basePath, homePath);
    copyFileSync(basePath, suitcasePath);
    const home = new Database(homePath);
    home.prepare('INSERT INTO notes VALUES (?, ?)').run('home-flow', 'home');
    home.close();
    const suitcase = new Database(suitcasePath);
    suitcase.prepare('INSERT INTO notes VALUES (?, ?)').run('away-flow', 'away');
    suitcase.close();
    const base = await reconciliation.createDataCheckpoint({
      appId: 'app-flow',
      originSiteId: 'site-home',
      databasePath: basePath,
      schemaFingerprint: 'sha256:same-schema',
      profileVersion: 'sha256:profile',
    });
    const current = await reconciliation.createDataCheckpoint({
      appId: 'app-flow',
      originSiteId: 'site-home',
      parentId: base.id,
      databasePath: homePath,
      schemaFingerprint: 'sha256:same-schema',
      profileVersion: 'sha256:profile',
    });
    reconciliation.setDataSyncPolicy({
      appId: 'app-flow',
      siteId: 'site-away',
      policy: 'automatic',
      updatedBy: 'admin',
    });
    const changeset = await reconciliation.createDataChangeset({
      appId: 'app-flow',
      originSiteId: 'site-away',
      baseCheckpointId: base.id,
      databasePath: suitcasePath,
      schemaFingerprint: 'sha256:same-schema',
    });
    const changesetArtifact = store
      .getSqlite()!
      .prepare(
        `SELECT a.local_path, a.type, a.media_type
           FROM data_changesets c
           JOIN artifacts a ON a.digest = c.database_artifact_digest
          WHERE c.id = ?`,
      )
      .get(changeset.id) as { local_path: string; type: string; media_type: string };
    assert.equal(changesetArtifact.type, 'sqlite-session-changeset');
    assert.equal(changesetArtifact.media_type, 'application/vnd.sqlite3.changeset');
    assert.notEqual(
      readFileSync(changesetArtifact.local_path).subarray(0, 16).toString('utf8'),
      'SQLite format 3\0',
    );
    const applied = await reconciliation.applyDataChangeset({
      changesetId: changeset.id,
      currentCheckpointId: current.id,
      coordinatorSiteId: 'site-home',
      stagingDatabasePath: join(root, 'flow-staging.db'),
    });
    const appliedConflict =
      applied.status === 'merged'
        ? null
        : store
            .getSqlite()!
            .prepare('SELECT * FROM data_conflicts WHERE id = ?')
            .get(applied.conflictIds[0]);
    const changesetRecord = store
      .getSqlite()!
      .prepare('SELECT conflict_report FROM data_changesets WHERE id = ?')
      .get(changeset.id);
    assert.equal(
      applied.status,
      'merged',
      JSON.stringify({ applied, appliedConflict, changesetRecord }),
    );
    const checkpointId = (applied as { checkpointId: string }).checkpointId;
    const checkpoint = store
      .getSqlite()!
      .prepare(
        'SELECT database_artifact_digest, verification_status FROM data_checkpoints WHERE id = ?',
      )
      .get(checkpointId) as { database_artifact_digest: string; verification_status: string };
    const artifact = store
      .getSqlite()!
      .prepare('SELECT local_path FROM artifacts WHERE digest = ?')
      .get(checkpoint.database_artifact_digest) as { local_path: string };
    assert.equal(checkpoint.verification_status, 'verified');
    assert.deepEqual(
      noteRows(artifact.local_path).map((row) => row.id),
      ['away-flow', 'base', 'home-flow'],
    );
    const replay = await reconciliation.applyDataChangeset({
      changesetId: changeset.id,
      currentCheckpointId: checkpointId,
      coordinatorSiteId: 'site-home',
      stagingDatabasePath: join(root, 'flow-replay.db'),
    });
    assert.deepEqual(replay, { status: 'merged', checkpointId });
  });
});
