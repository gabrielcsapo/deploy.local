import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import type { GraphExecutorContext, GraphRecoveryArtifact } from './application-graph-executor.ts';
import { compileDeployYaml } from './application-spec.ts';
import type { SuitcaseDataExecutor } from './suitcase-data-bridge.ts';

const MANIFEST = compileDeployYaml(`apiVersion: deploy.local/v1
kind: Application
components:
  web:
    image: example/notes:1
    role: web
    mounts:
      /app/data:
        resource: data
resources:
  data:
    type: volume
    durability: durable
    dataRole: database
    access: singleWriter
`);

let root: string;
let store: typeof import('./store.ts');
let multisite: typeof import('./multisite.ts');
let data: typeof import('./data-reconciliation.ts');
let coordinator: typeof import('./reconciliation-coordinator.ts');
let homeSiteId: string;
let executor: FakeDataExecutor;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-reconciliation-coordinator-'));
  process.env.DEPLOY_DATA_DIR = join(root, 'state');
  store = await import(`./store.ts?reconciliation-coordinator=${Date.now()}`);
  multisite = await import(`./multisite.ts?reconciliation-coordinator=${Date.now()}`);
  data = await import(`./data-reconciliation.ts?reconciliation-coordinator=${Date.now()}`);
  coordinator = await import(
    `./reconciliation-coordinator.ts?reconciliation-coordinator=${Date.now()}`
  );
  const fleet = multisite.ensureFleetIdentity();
  homeSiteId = fleet.homeSiteId;
  executor = new FakeDataExecutor();
  const now = new Date().toISOString();
  store
    .getSqlite()!
    .prepare(
      `INSERT INTO sites
        (id, fleet_id, name, kind, public_key, credential_status, capabilities,
         mode, default_data_policy, access_mode, security_profile, readiness_summary,
         created_at, updated_at)
       VALUES ('site-trip', ?, 'Trip', 'suitcase', 'test-key', 'active', '{}',
               'docked', 'automatic', 'existing-lan', 'isolated', '{}', ?, ?)`,
    )
    .run(fleet.id, now, now);
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

function database(path: string, extraId?: string): void {
  const sqlite = new Database(path);
  sqlite.exec('CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL) STRICT');
  sqlite.prepare('INSERT INTO notes VALUES (?, ?)').run('base', 'base');
  if (extraId) sqlite.prepare('INSERT INTO notes VALUES (?, ?)').run(extraId, extraId);
  sqlite.close();
}

function notes(path: string): Array<{ id: string; body: string }> {
  const sqlite = new Database(path, { readonly: true });
  const rows = sqlite.prepare('SELECT id, body FROM notes ORDER BY id').all() as Array<{
    id: string;
    body: string;
  }>;
  sqlite.close();
  return rows;
}

async function createFlow(
  appId: string,
  policy: 'automatic' | 'manual',
  options: { conflictingUpdate?: boolean } = {},
) {
  const now = new Date().toISOString();
  const profileVersion = `profile-${appId}`;
  const volumeRoot = join(root, `${appId}-home-volume`);
  mkdirSync(volumeRoot, { recursive: true });
  store
    .getSqlite()!
    .prepare(
      `INSERT INTO deployments
        (name, username, app_id, status, directory, desired_spec_digest, active_spec_digest,
         created_at, updated_at)
       VALUES (?, 'admin', ?, 'running', ?, ?, ?, ?, ?)`,
    )
    .run(appId, appId, root, MANIFEST.digest, MANIFEST.digest, now, now);
  store
    .getSqlite()!
    .prepare(
      `INSERT INTO application_spec_revisions
        (digest, deployment_name, parent_digest, api_version, source, manifest_format,
         normalized_spec, created_by, created_at)
       VALUES (?, ?, NULL, 'deploy.local/v1', 'repository', 'deploy.yaml', ?, 'admin', ?)`,
    )
    .run(MANIFEST.digest, appId, MANIFEST.canonicalJson, now);
  store
    .getSqlite()!
    .prepare(
      `INSERT INTO data_reconciliation_profiles
        (id, app_id, version, analyzer_version, sqlite_files, eligible_tables,
         excluded_tables, upload_paths, opaque_paths, compatibility_digest, findings, created_at)
       VALUES (?, ?, ?, '1.0.0', ?, ?, '[]', '[]', '[]', ?, '[]', ?)`,
    )
    .run(
      profileVersion,
      appId,
      profileVersion,
      JSON.stringify([{ resource: 'data', relativePath: 'app.sqlite' }]),
      JSON.stringify([{ file: 'data/app.sqlite', table: 'notes', primaryKey: ['id'] }]),
      `sha256:${'a'.repeat(64)}`,
      now,
    );
  store
    .getSqlite()!
    .prepare(
      `INSERT INTO app_replicas
        (id, app_id, site_id, runtime_status, data_mode, sync_policy,
         shared_lineage, profile_version, readiness, created_at, updated_at)
       VALUES (?, ?, ?, 'running', 'replicated', 'automatic', 1, ?, '{}', ?, ?),
              (?, ?, 'site-trip', 'running', 'replicated', ?, 1, ?, '{}', ?, ?)`,
    )
    .run(
      `replica-home-${appId}`,
      appId,
      homeSiteId,
      profileVersion,
      now,
      now,
      `replica-trip-${appId}`,
      appId,
      policy,
      profileVersion,
      now,
      now,
    );
  data.setDataSyncPolicy({
    appId,
    siteId: homeSiteId,
    policy: 'automatic',
    updatedBy: 'admin',
  });
  data.setDataSyncPolicy({
    appId,
    siteId: 'site-trip',
    policy,
    updatedBy: 'admin',
  });
  const basePath = join(root, `${appId}-base.sqlite`);
  const branchPath = join(root, `${appId}-branch.sqlite`);
  database(basePath);
  copyFileSync(basePath, join(volumeRoot, 'app.sqlite'));
  const home = new Database(join(volumeRoot, 'app.sqlite'));
  if (options.conflictingUpdate) {
    home.prepare('UPDATE notes SET body = ? WHERE id = ?').run('edited-at-home', 'base');
  } else {
    home.prepare('INSERT INTO notes VALUES (?, ?)').run(`${policy}-home`, `${policy}-home`);
  }
  home.close();
  database(branchPath, options.conflictingUpdate ? undefined : `${policy}-away`);
  if (options.conflictingUpdate) {
    const branch = new Database(branchPath);
    branch.prepare('UPDATE notes SET body = ? WHERE id = ?').run('edited-on-suitcase', 'base');
    branch.close();
  }
  executor.volumes.set(appId, volumeRoot);
  const base = await data.createDataCheckpoint({
    appId,
    originSiteId: homeSiteId,
    databasePath: basePath,
    profileVersion,
  });
  store
    .getSqlite()!
    .prepare('UPDATE app_replicas SET base_checkpoint_id = ? WHERE app_id = ?')
    .run(base.id, appId);
  const changeset = await data.createDataChangeset({
    appId,
    originSiteId: 'site-trip',
    baseCheckpointId: base.id,
    databasePath: branchPath,
    explicitManual: policy === 'manual',
  });
  return { changesetId: changeset.id, volumeRoot };
}

describe('docked reconciliation coordinator', () => {
  it('merges automatic branches and waits for explicit manual sync', async () => {
    const automatic = await createFlow('app-auto', 'automatic');
    const automaticResult = await coordinator.reconcilePendingChangesets({
      originSiteId: 'site-trip',
      executor,
    });
    assert.equal(
      automaticResult.find((item) => item.changesetId === automatic.changesetId)?.status,
      'merged',
      JSON.stringify(
        store
          .getSqlite()!
          .prepare(
            "SELECT blockers FROM app_materialization WHERE app_id = ? AND capability = 'data'",
          )
          .all('app-auto'),
      ),
    );
    assert.deepEqual(notes(join(automatic.volumeRoot, 'app.sqlite')), [
      { id: 'automatic-away', body: 'automatic-away' },
      { id: 'automatic-home', body: 'automatic-home' },
      { id: 'base', body: 'base' },
    ]);

    const manual = await createFlow('app-manual', 'manual');
    const background = await coordinator.reconcilePendingChangesets({
      originSiteId: 'site-trip',
      executor,
    });
    assert.equal(
      background.some((item) => item.changesetId === manual.changesetId),
      false,
    );
    assert.equal(
      (
        store
          .getSqlite()!
          .prepare('SELECT status FROM data_changesets WHERE id = ?')
          .get(manual.changesetId) as { status: string }
      ).status,
      'pending',
    );
    assert.deepEqual(notes(join(manual.volumeRoot, 'app.sqlite')), [
      { id: 'base', body: 'base' },
      { id: 'manual-home', body: 'manual-home' },
    ]);
    const explicit = await coordinator.reconcilePendingChangesets({
      originSiteId: 'site-trip',
      explicitManual: true,
      executor,
    });
    assert.equal(
      explicit.find((item) => item.changesetId === manual.changesetId)?.status,
      'merged',
    );
    assert.deepEqual(notes(join(manual.volumeRoot, 'app.sqlite')), [
      { id: 'base', body: 'base' },
      { id: 'manual-away', body: 'manual-away' },
      { id: 'manual-home', body: 'manual-home' },
    ]);
    assert.equal(
      executor.captureResume.every((resume) => resume === false),
      true,
    );
  });

  it('keeps Home live until a conflict choice produces and restores a verified checkpoint', async () => {
    const flow = await createFlow('app-conflict', 'automatic', { conflictingUpdate: true });
    const initial = await coordinator.reconcilePendingChangesets({
      originSiteId: 'site-trip',
      executor,
    });
    assert.equal(
      initial.find((item) => item.changesetId === flow.changesetId)?.status,
      'merged-home-restore-blocked',
    );
    assert.deepEqual(notes(join(flow.volumeRoot, 'app.sqlite')), [
      { id: 'base', body: 'edited-at-home' },
    ]);
    const conflict = store
      .getSqlite()!
      .prepare(
        `SELECT id, changeset_id FROM data_conflicts
          WHERE app_id = 'app-conflict' AND status = 'open'`,
      )
      .get() as { id: string; changeset_id: string };
    assert.ok(conflict);

    const resolved = await coordinator.resolveAndMaterializeDataConflict({
      conflictId: conflict.id,
      resolution: 'suitcase',
      resolvedBy: 'admin',
      executor,
    });
    assert.equal(resolved.pendingConflicts, false);
    assert.equal(
      resolved.results.find((item) => item.changesetId === conflict.changeset_id)?.status,
      'merged',
    );
    assert.deepEqual(notes(join(flow.volumeRoot, 'app.sqlite')), [
      { id: 'base', body: 'edited-on-suitcase' },
    ]);
    const materialization = store
      .getSqlite()!
      .prepare(
        `SELECT state, desired_digest, available_digest
           FROM app_materialization
          WHERE app_id = 'app-conflict' AND site_id = ? AND capability = 'data'`,
      )
      .get(homeSiteId) as {
      state: string;
      desired_digest: string;
      available_digest: string;
    };
    assert.equal(materialization.state, 'ready');
    assert.equal(materialization.available_digest, materialization.desired_digest);
    assert.equal(executor.restoredCheckpoints.includes('app-conflict'), true);
  });

  it('does not consume a Suitcase branch when Home cannot be captured cold', async () => {
    const flow = await createFlow('app-capture-failure', 'automatic');
    executor.volumes.delete('app-capture-failure');
    const result = await coordinator.reconcilePendingChangesets({
      originSiteId: 'site-trip',
      executor,
    });
    assert.equal(
      result.find((item) => item.changesetId === flow.changesetId)?.status,
      'waiting-for-home-capture',
    );
    assert.equal(
      (
        store
          .getSqlite()!
          .prepare('SELECT status FROM data_changesets WHERE id = ?')
          .get(flow.changesetId) as { status: string }
      ).status,
      'pending',
    );
    assert.deepEqual(notes(join(flow.volumeRoot, 'app.sqlite')), [
      { id: 'automatic-home', body: 'automatic-home' },
      { id: 'base', body: 'base' },
    ]);
  });
});

class FakeDataExecutor implements SuitcaseDataExecutor {
  readonly volumes = new Map<string, string>();
  readonly restoredCheckpoints: string[] = [];
  readonly captureResume: boolean[] = [];

  async createRecoveryPoint(
    context: GraphExecutorContext,
    destinationDirectory: string,
    options: { resume?: boolean } = {},
  ): Promise<GraphRecoveryArtifact> {
    const volumeRoot = this.volume(context.applicationId);
    this.captureResume.push(options.resume !== false);
    mkdirSync(destinationDirectory, { recursive: true });
    const archive = join(destinationDirectory, 'data.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', volumeRoot, '.']);
    const recovery = {
      version: 1,
      applicationId: context.applicationId,
      siteId: context.siteId,
      specDigest: context.runtime.execution.specDigest,
      configurationDigest: context.runtime.configurationDigest,
      resources: [
        {
          resource: 'data',
          archive: 'data.tar.gz',
          digest: fileDigest(archive),
          bytes: statSync(archive).size,
        },
      ],
    };
    const manifest = `${JSON.stringify(recovery, null, 2)}\n`;
    const manifestPath = join(destinationDirectory, 'recovery-manifest.json');
    writeFileSync(manifestPath, manifest, { encoding: 'utf8', mode: 0o600 });
    return {
      artifactReference: manifestPath,
      artifactDigest: digest(Buffer.from(manifest)),
      verification: 'fake-cold-volume-archive',
    };
  }

  async restoreRecoveryPoint(
    context: GraphExecutorContext,
    artifact: Pick<GraphRecoveryArtifact, 'artifactReference' | 'artifactDigest'>,
  ): Promise<void> {
    const manifest = readFileSync(artifact.artifactReference);
    assert.equal(digest(manifest), artifact.artifactDigest);
    const recovery = JSON.parse(manifest.toString('utf8')) as {
      applicationId: string;
      siteId: string;
      resources: Array<{ resource: string; archive: string; digest: string }>;
    };
    assert.equal(recovery.applicationId, context.applicationId);
    assert.equal(recovery.siteId, context.siteId);
    const volumeRoot = this.volume(context.applicationId);
    rmSync(volumeRoot, { recursive: true, force: true });
    mkdirSync(volumeRoot, { recursive: true });
    for (const resource of recovery.resources) {
      assert.equal(resource.resource, 'data');
      const archive = join(dirname(artifact.artifactReference), resource.archive);
      assert.equal(existsSync(archive), true);
      assert.equal(fileDigest(archive), resource.digest);
      execFileSync('tar', ['-xzf', archive, '-C', volumeRoot]);
    }
    this.restoredCheckpoints.push(context.applicationId);
  }

  private volume(applicationId: string): string {
    const volume = this.volumes.get(applicationId);
    if (!volume) throw new Error(`Fake volume is unavailable for ${applicationId}`);
    return volume;
  }
}

function digest(content: Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function fileDigest(path: string): `sha256:${string}` {
  return digest(readFileSync(path));
}
