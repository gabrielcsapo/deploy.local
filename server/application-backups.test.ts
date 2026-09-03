import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import type {
  GraphExecutorContext,
  GraphMaterializationResult,
  GraphRecoveryArtifact,
} from './application-graph-executor.ts';
import {
  createCoordinatorApplicationBackup,
  restoreCoordinatorApplicationBackup,
} from './application-backups.ts';
import { buildApplicationGraphRuntime } from './application-runtime.ts';
import { compileDeployYaml } from './application-spec.ts';

const compiled = compileDeployYaml(`
apiVersion: deploy.local/v1
kind: Application
components:
  web:
    image: example/web:1
    interfaces:
      http: { port: 3000, protocol: http }
resources:
  database:
    type: volume
    dataRole: database
    consistencyGroup: primary
    backup: { policy: required, retentionCopies: 3 }
  uploads:
    type: volume
    consistencyGroup: media
    backup: { policy: include, retentionCopies: 2 }
  cache:
    type: volume
    durability: ephemeral
    backup: { policy: exclude, retentionCopies: 0 }
routes:
  public: { to: web.http }
`);

const graphRuntime = buildApplicationGraphRuntime({
  applicationId: 'notes-id',
  specDigest: compiled.digest,
  spec: compiled.spec,
  configuration: { digest: 'sha256:configuration', values: {}, missing: [] },
});

const deployment = {
  name: 'notes',
  appId: 'notes-id',
  activeNodeId: 'coordinator',
  activeSpecDigest: compiled.digest,
  directory: '/srv/notes',
};

describe('coordinator application backups', () => {
  it('creates and restores one digest-bound recovery point for the application graph', async () => {
    const root = mkdtempSync(join(tmpdir(), 'deploy-graph-backup-'));
    const executor = new RecordingGraphExecutor();
    try {
      const backup = await createCoordinatorApplicationBackup(deployment, 'before upgrade', {
        executor,
        backupDirectory: () => root,
        manifestFormat: () => 'deploy.yaml',
        graphRuntime: () => graphRuntime,
        now: () => new Date('2026-08-08T12:34:56.789Z'),
      });

      assert.equal(backup.format, 'application-graph');
      assert.match(
        backup.filename,
        /^2026-08-08T12-34-56-789Z-before_upgrade-[a-f0-9]{64}\.graph$/,
      );
      assert.deepEqual(backup.volumePaths, ['uploads', 'database']);
      assert.equal(executor.created.length, 1);
      assert.equal(executor.created[0].context.applicationId, 'notes-id');
      assert.equal(executor.created[0].context.siteId, 'coordinator');
      assert.equal(executor.created[0].context.projectDirectory, '/srv/notes');
      assert.equal(executor.created[0].destination.startsWith(root), true);

      const restored = await restoreCoordinatorApplicationBackup(deployment, backup.filename, {
        executor,
        backupDirectory: () => root,
        manifestFormat: () => 'deploy.yaml',
        graphRuntime: () => graphRuntime,
      });

      assert.equal(restored.format, 'application-graph');
      assert.equal(executor.restored.length, 1);
      assert.equal(executor.converged.length, 1);
      assert.equal(
        executor.restored[0].artifact.artifactReference,
        resolve(root, backup.filename, 'recovery-manifest.json'),
      );
      assert.equal(
        executor.restored[0].artifact.artifactDigest,
        `sha256:${backup.filename.match(/-([a-f0-9]{64})\.graph$/)![1]}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects legacy tarballs for a graph before stopping or restoring it', async () => {
    const executor = new RecordingGraphExecutor();
    await assert.rejects(
      restoreCoordinatorApplicationBackup(deployment, 'legacy.tar.gz', {
        executor,
        manifestFormat: () => 'deploy.yaml',
        graphRuntime: () => graphRuntime,
      }),
      /not an application graph recovery point/,
    );
    assert.equal(executor.restored.length, 0);
    assert.equal(executor.converged.length, 0);
  });
});

class RecordingGraphExecutor {
  readonly created: Array<{ context: GraphExecutorContext; destination: string }> = [];
  readonly restored: Array<{
    context: GraphExecutorContext;
    artifact: Pick<GraphRecoveryArtifact, 'artifactReference' | 'artifactDigest'>;
  }> = [];
  readonly converged: GraphExecutorContext[] = [];

  async createRecoveryPoint(
    context: GraphExecutorContext,
    destination: string,
  ): Promise<GraphRecoveryArtifact> {
    this.created.push({ context, destination });
    mkdirSync(destination, { recursive: true });
    const content = `${JSON.stringify({ version: 1, resources: ['database', 'uploads'] })}\n`;
    const artifactReference = resolve(destination, 'recovery-manifest.json');
    writeFileSync(artifactReference, content);
    writeFileSync(resolve(destination, 'database.tar.gz'), 'database');
    writeFileSync(resolve(destination, 'uploads.tar.gz'), 'uploads');
    return {
      artifactReference,
      artifactDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      verification: 'test',
    };
  }

  async restoreRecoveryPoint(
    context: GraphExecutorContext,
    artifact: Pick<GraphRecoveryArtifact, 'artifactReference' | 'artifactDigest'>,
  ): Promise<void> {
    this.restored.push({ context, artifact });
  }

  async converge(context: GraphExecutorContext): Promise<GraphMaterializationResult> {
    this.converged.push(context);
    return {
      applicationId: context.applicationId,
      releaseDigest: context.runtime.execution.specDigest,
      configurationDigest: context.runtime.configurationDigest,
      network: 'notes-network',
      primaryPort: 3000,
      primaryContainerId: 'container-id',
      primaryContainerName: 'notes-web',
      instances: [],
    };
  }
}
