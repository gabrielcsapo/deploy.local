import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { GraphExecutorContext, GraphRecoveryArtifact } from './application-graph-executor.ts';
import type { SuitcaseDataExecutor } from './suitcase-data-bridge.ts';

const MANIFEST = `
apiVersion: deploy.local/v1
kind: Application
metadata:
  name: photos
components:
  web:
    image: example/photos:1
    role: web
    mounts:
      /photos:
        resource: data
resources:
  data:
    type: volume
    durability: durable
    dataRole: files
    access: singleWriter
`;

let root: string;
let volume: string;
let store: typeof import('./store.ts');
let multisite: typeof import('./multisite.ts');
let reconciliation: typeof import('./data-reconciliation.ts');
let specs: typeof import('./application-spec.ts');
let bridge: typeof import('./suitcase-data-bridge.ts');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-suitcase-data-'));
  volume = join(root, 'live-volume');
  mkdirSync(volume, { recursive: true });
  writeFileSync(join(volume, 'upload.txt'), 'home version');
  process.env.DEPLOY_DATA_DIR = join(root, 'control');
  store = await import(`./store.ts?data-bridge=${Date.now()}`);
  multisite = await import(`./multisite.ts?data-bridge=${Date.now()}`);
  reconciliation = await import(`./data-reconciliation.ts?data-bridge=${Date.now()}`);
  specs = await import(`./application-spec.ts?data-bridge=${Date.now()}`);
  bridge = await import(`./suitcase-data-bridge.ts?data-bridge=${Date.now()}`);
  const fleet = multisite.ensureFleetIdentity();
  const now = new Date().toISOString();
  store
    .getSqlite()!
    .prepare(
      `INSERT INTO sites
        (id, fleet_id, name, kind, public_key, credential_status, capabilities, mode,
         default_data_policy, access_mode, security_profile, readiness_summary, created_at, updated_at)
       VALUES ('site-suitcase', ?, 'Travel', 'suitcase', 'public', 'active', '{}', 'docked',
               'automatic', 'existing-lan', 'isolated', '{}', ?, ?)`,
    )
    .run(fleet.id, now, now);
  store
    .getSqlite()!
    .prepare(
      `INSERT INTO data_reconciliation_profiles
        (id, app_id, version, analyzer_version, sqlite_files, eligible_tables,
         excluded_tables, upload_paths, opaque_paths, compatibility_digest, findings, created_at)
       VALUES ('profile-files', 'app-photos', 'profile-files', '1.0.0', '[]', '[]', '[]',
               '["data/upload.txt"]', '[]', 'sha256:compatibility', '[]', ?)`,
    )
    .run(now);
  store
    .getSqlite()!
    .prepare(
      `INSERT INTO app_replicas
        (id, app_id, site_id, runtime_status, data_mode, sync_policy, shared_lineage,
         profile_version, readiness, created_at, updated_at)
       VALUES ('replica-photos', 'app-photos', 'site-suitcase', 'running', 'replicated',
               'automatic', 1, 'profile-files', '{}', ?, ?)`,
    )
    .run(now, now);
  reconciliation.setDataSyncPolicy({
    appId: 'app-photos',
    siteId: 'site-suitcase',
    policy: 'automatic',
    updatedBy: 'admin',
  });
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('Suitcase shared-data bridge', () => {
  it('creates a fresh base, restores exact named volumes, and captures only changed branches', async () => {
    const compiled = specs.compileDeployYaml(MANIFEST);
    const runtime = {
      execution: { specDigest: compiled.digest },
      configurationDigest: 'sha256:configuration',
    } as GraphExecutorContext['runtime'];
    const context = {
      deploymentName: 'photos',
      applicationId: 'app-photos',
      siteId: 'site-home',
      projectDirectory: root,
      runtime,
    } as GraphExecutorContext;
    const executor = new FakeDataExecutor(volume);
    const checkpoint = await bridge.createInitialSuitcaseCheckpoint({
      applicationId: 'app-photos',
      originSiteId: 'site-home',
      profileVersion: 'profile-files',
      context,
      executor,
      actor: 'admin',
    });
    const record = store
      .getSqlite()!
      .prepare(
        `SELECT filesystem_artifact_digest, profile_version FROM data_checkpoints WHERE id = ?`,
      )
      .get(checkpoint.id) as { filesystem_artifact_digest: string; profile_version: string };
    assert.equal(record.profile_version, 'profile-files');
    const fileManifest = reconciliation.loadFileManifestArtifact(record.filesystem_artifact_digest);
    assert.equal(fileManifest.entries['data/upload.txt']?.kind, 'file');

    const suitcaseContext = { ...context, siteId: 'site-suitcase' };
    const restored = await bridge.restoreSuitcaseCheckpoint({
      applicationId: 'app-photos',
      siteId: 'site-suitcase',
      checkpointId: checkpoint.id,
      profileVersion: 'profile-files',
      spec: compiled.spec,
      context: suitcaseContext,
      executor,
    });
    assert.equal(restored.reused, false);
    assert.equal(executor.restored.length, 1);
    assert.deepEqual(executor.restored[0]!.resources, ['data']);

    writeFileSync(join(volume, 'upload.txt'), 'suitcase version');
    const captured = await bridge.captureSuitcaseDataBranch({
      applicationId: 'app-photos',
      siteId: 'site-suitcase',
      baseCheckpointId: checkpoint.id,
      profileVersion: 'profile-files',
      context: suitcaseContext,
      executor,
    });
    assert.equal(captured.status, 'captured');
    const branch = store
      .getSqlite()!
      .prepare('SELECT status, base_checkpoint_id FROM data_changesets WHERE id = ?')
      .get(captured.changesetId) as { status: string; base_checkpoint_id: string };
    assert.deepEqual(branch, { status: 'pending', base_checkpoint_id: checkpoint.id });
    const repeated = await bridge.captureSuitcaseDataBranch({
      applicationId: 'app-photos',
      siteId: 'site-suitcase',
      baseCheckpointId: checkpoint.id,
      profileVersion: 'profile-files',
      context: suitcaseContext,
      executor,
    });
    assert.equal(repeated.status, 'pending');
  });
});

class FakeDataExecutor implements SuitcaseDataExecutor {
  readonly restored: Array<{ artifact: GraphRecoveryArtifact; resources: string[] }> = [];
  private readonly volumeRoot: string;

  constructor(volumeRoot: string) {
    this.volumeRoot = volumeRoot;
  }

  async createRecoveryPoint(
    context: GraphExecutorContext,
    destinationDirectory: string,
  ): Promise<GraphRecoveryArtifact> {
    mkdirSync(destinationDirectory, { recursive: true });
    const archive = join(destinationDirectory, 'data.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', this.volumeRoot, '.']);
    const bytes = readFileSync(archive);
    const manifest = {
      version: 1,
      applicationId: context.applicationId,
      siteId: context.siteId,
      specDigest: context.runtime.execution.specDigest,
      configurationDigest: context.runtime.configurationDigest,
      resources: [
        {
          resource: 'data',
          archive: 'data.tar.gz',
          digest: digest(bytes),
          bytes: statSync(archive).size,
        },
      ],
    };
    const manifestPath = join(destinationDirectory, 'recovery-manifest.json');
    const content = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(manifestPath, content);
    return {
      artifactReference: manifestPath,
      artifactDigest: digest(content),
      verification: 'fake-cold-capture',
    };
  }

  async restoreRecoveryPoint(
    _context: GraphExecutorContext,
    artifact: Pick<GraphRecoveryArtifact, 'artifactReference' | 'artifactDigest'>,
  ): Promise<void> {
    const parsed = JSON.parse(readFileSync(artifact.artifactReference, 'utf8')) as {
      resources: Array<{ resource: string }>;
    };
    this.restored.push({
      artifact: { ...artifact, verification: 'restored' },
      resources: parsed.resources.map((resource) => resource.resource),
    });
  }
}

function digest(value: Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
