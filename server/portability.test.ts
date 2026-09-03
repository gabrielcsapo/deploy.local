import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { compileApplicationManifest } from './application-spec.ts';

let dataDirectory: string;
let snapshots: string;
let portability: typeof import('./portability.ts');
let store: typeof import('./store.ts');

before(async () => {
  dataDirectory = mkdtempSync(join(tmpdir(), 'deploy-portability-'));
  snapshots = join(dataDirectory, 'snapshots');
  mkdirSync(snapshots, { recursive: true });
  process.env.DEPLOY_DATA_DIR = join(dataDirectory, 'control');
  store = await import(`./store.ts?portability=${Date.now()}`);
  portability = await import(`./portability.ts?portability=${Date.now()}`);
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(dataDirectory, { recursive: true, force: true });
});

function sqliteSpec(dataRole: 'database' | 'files' = 'database') {
  return compileApplicationManifest({
    apiVersion: 'deploy.local/v1',
    kind: 'Application',
    components: {
      web: {
        image:
          'example/notes@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        mounts: { '/app/data': { resource: 'data' } },
      },
    },
    resources: {
      data: { type: 'volume', durability: 'durable', dataRole, access: 'singleWriter' },
    },
  });
}

function target() {
  return {
    platform: 'linux',
    architecture: 'arm64',
    compatibleArchitectures: ['amd64', 'arm64'],
    runtimeAvailable: true,
    secretsMaterialized: true,
    artifactsMaterialized: true,
    offlineAccessValidated: true,
    offlineBuildValidated: true,
    reconciliationValidated: true,
  };
}

describe('suitcase portability analyzer', () => {
  it('classifies an ordinary SQLite app without an application-specific library', () => {
    const root = join(snapshots, 'safe-sqlite');
    mkdirSync(root, { recursive: true });
    const database = new Database(join(root, 'notes.db'));
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE notes (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL
      ) STRICT;
      CREATE TABLE comments (
        id INTEGER PRIMARY KEY,
        note_id TEXT NOT NULL REFERENCES notes(id),
        body TEXT NOT NULL
      ) STRICT;
      INSERT INTO notes VALUES ('note-home-1', 'Packed', 'Ready to leave');
    `);
    database.close();
    writeFileSync(join(root, 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    const compiled = sqliteSpec();
    const report = portability.analyzePortability({
      appId: 'app-notes',
      specDigest: compiled.digest,
      siteId: 'site-suitcase',
      spec: compiled.spec,
      volumes: [{ resource: 'data', snapshotPath: root }],
      target: target(),
    });

    assert.equal(report.classification, 'sqlite-replica');
    assert.equal(report.syncsAcrossSites, true);
    assert.equal(report.capabilityVector.dataCoverage.status, 'pass');
    assert.equal(report.capabilityVector.conflictSafety.status, 'conditional');
    assert.deepEqual(
      report.reconciliationProfile.eligibleTables.map((table) => table.table),
      ['comments', 'notes'],
    );
    assert.equal(
      report.findings.some(
        (finding) => finding.id === 'DATA.SQLITE.INTEGER_PRIMARY_KEY_COLLISION_RISK',
      ),
      true,
    );

    portability.persistPortabilityReport(report);
    const saved = store
      .getSqlite()!
      .prepare('SELECT classification FROM portability_reports WHERE id = ?')
      .get(report.id) as { classification: string };
    assert.equal(saved.classification, 'sqlite-replica');
  });

  it('fails closed to Follows one site when a durable table has no key', () => {
    const root = join(snapshots, 'unsafe-sqlite');
    mkdirSync(root, { recursive: true });
    const database = new Database(join(root, 'legacy.db'));
    database.exec('CREATE TABLE audit_log (message TEXT, created_at TEXT)');
    database.close();

    const compiled = sqliteSpec();
    const report = portability.analyzePortability({
      appId: 'app-legacy',
      specDigest: compiled.digest,
      siteId: 'site-suitcase',
      spec: compiled.spec,
      volumes: [{ resource: 'data', snapshotPath: root }],
      target: target(),
    });

    assert.equal(report.classification, 'follows-one-site');
    assert.equal(report.syncsAcrossSites, false);
    assert.equal(report.capabilityVector.dataCoverage.status, 'block');
    assert.equal(
      report.findings.some((finding) => finding.id === 'DATA.SQLITE.TABLE_NO_PRIMARY_KEY'),
      true,
    );
  });

  it('fails closed when generic reconciliation discovers multiple SQLite files', () => {
    const root = join(snapshots, 'multiple-sqlite');
    mkdirSync(root, { recursive: true });
    for (const filename of ['notes.db', 'settings.db']) {
      const database = new Database(join(root, filename));
      database.exec(
        'CREATE TABLE records (id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT',
      );
      database.close();
    }

    const compiled = sqliteSpec();
    const report = portability.analyzePortability({
      appId: 'app-multiple-sqlite',
      specDigest: compiled.digest,
      siteId: 'site-suitcase',
      spec: compiled.spec,
      volumes: [{ resource: 'data', snapshotPath: root }],
      target: target(),
    });

    assert.equal(report.classification, 'follows-one-site');
    assert.equal(report.syncsAcrossSites, false);
    assert.equal(report.capabilityVector.dataCoverage.status, 'block');
    assert.equal(
      report.findings.some(
        (finding) => finding.id === 'DATA.SQLITE.MULTIPLE_DATABASES_UNSUPPORTED',
      ),
      true,
    );
  });

  it('applies declared table/path exclusions without treating annotations as a safety bypass', () => {
    const root = join(snapshots, 'annotated-sqlite');
    mkdirSync(join(root, 'scratch'), { recursive: true });
    const database = new Database(join(root, 'notes.db'));
    database.exec(`
      CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL) STRICT;
      CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL) STRICT;
    `);
    database.close();
    writeFileSync(join(root, 'photo.txt'), 'shared upload');
    writeFileSync(join(root, 'scratch', 'preview.txt'), 'site-local derived preview');
    const compiled = compileApplicationManifest({
      apiVersion: 'deploy.local/v1',
      kind: 'Application',
      components: {
        web: {
          image: 'example/notes',
          mounts: { '/app/data': { resource: 'data' } },
        },
      },
      resources: {
        data: {
          type: 'volume',
          dataRole: 'database',
          reconciliation: {
            excludeTables: ['sessions'],
            excludePaths: ['scratch'],
            conflictPolicy: 'prefer-home',
          },
        },
      },
    });
    const report = portability.analyzePortability({
      appId: 'app-annotated',
      specDigest: compiled.digest,
      siteId: 'site-suitcase',
      spec: compiled.spec,
      volumes: [{ resource: 'data', snapshotPath: root }],
      target: target(),
    });

    assert.deepEqual(
      report.reconciliationProfile.eligibleTables.map((table) => table.table),
      ['notes'],
    );
    assert.equal(
      report.reconciliationProfile.excludedTables.find((table) => table.table === 'sessions')
        ?.reason,
      'excluded by deploy.yaml reconciliation guidance',
    );
    assert.deepEqual(report.reconciliationProfile.uploadPaths, ['data/photo.txt']);
    assert.equal(report.reconciliationProfile.conflictPolicy, 'prefer-home');
    assert.equal(
      report.findings.some((finding) => finding.id === 'DATA.RECONCILIATION.DECLARED_EXCLUSIONS'),
      true,
    );
    portability.persistPortabilityReport(report);
    const saved = store
      .getSqlite()!
      .prepare('SELECT conflict_policy FROM data_reconciliation_profiles WHERE id = ?')
      .get(report.profileDigest) as { conflict_policy: string };
    assert.equal(saved.conflict_policy, 'prefer-home');
  });

  it('classifies uploaded files separately and blocks escaping symlinks', () => {
    const filesRoot = join(snapshots, 'files');
    mkdirSync(filesRoot, { recursive: true });
    writeFileSync(join(filesRoot, 'upload.txt'), 'hello suitcase');
    const compiled = sqliteSpec('files');
    const filesReport = portability.analyzePortability({
      appId: 'app-files',
      specDigest: compiled.digest,
      siteId: 'site-suitcase',
      spec: compiled.spec,
      volumes: [{ resource: 'data', snapshotPath: filesRoot }],
      target: target(),
    });
    assert.equal(filesReport.classification, 'file-replica');
    assert.equal(filesReport.reconciliationProfile.uploadPaths[0], 'data/upload.txt');
  });
});

describe('workload-derived suitcase capacity planner', () => {
  it('separates runtime minimum from recommended rolling/build/sync headroom', () => {
    const gib = 1024 ** 3;
    const plan = portability.planSuitcaseCapacity({
      fleetId: 'fleet-home',
      tripHorizonDays: 14,
      offlineBuilds: true,
      components: [
        {
          appId: 'app-notes',
          component: 'web',
          instances: 2,
          runtimeWorkingSet: { bytes: gib, confidence: 'measured', source: '30-day high water' },
          rollingSurgeInstances: 1,
          buildPeak: { bytes: 2 * gib, confidence: 'measured', source: 'no-network build probe' },
          storage: { bytes: 10 * gib, confidence: 'measured', source: 'volume snapshot' },
          projectedGrowthBytes: 2 * gib,
        },
      ],
      imageAndSourceBytes: { bytes: 8 * gib, confidence: 'measured', source: 'content store' },
      checkpointAndConflictBytes: {
        bytes: 12 * gib,
        confidence: 'declared',
        source: 'retention policy',
      },
      backupBytes: { bytes: 10 * gib, confidence: 'declared', source: 'backup policy' },
    });

    assert.equal(plan.minimumMemoryBytes, 6 * gib);
    assert.equal(plan.recommendedMemoryBytes, 12 * gib);
    assert.equal(plan.recommendedStorageBytes, 128 * gib);
    assert.equal(plan.selectedAppIds[0], 'app-notes');
    assert.equal(
      plan.contributors.some((item) => item.name === 'Largest serialized offline build'),
      true,
    );
  });
});
