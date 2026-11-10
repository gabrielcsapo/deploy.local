import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { GraphExecutorContext } from '../application-graph-executor.ts';
import type { CatalogRuntimeAdapter, CatalogTargetProfile } from './index.ts';

const dataDirectory = mkdtempSync(join(tmpdir(), 'deploy-catalog-store-'));
process.env.DEPLOY_DATA_DIR = dataDirectory;

const storeModule = await import('../store.ts');

const { DurableCatalogStore } = await import('./durable-store.ts');
const { loadValidationCatalog } = await import('./fixtures.ts');
const { CatalogService } = await import('./service.ts');
const { DeployLocalCatalogRuntime } = await import('./runtime.ts');

after(() => {
  storeModule._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(dataDirectory, { recursive: true, force: true });
});

const target: CatalogTargetProfile = {
  siteId: 'coordinator',
  deployLocalVersion: '1.0.0',
  operatingSystem: 'linux',
  architecture: 'amd64',
  engine: 'docker-engine',
  engineVersion: '28.0.0',
  memoryMiB: 8192,
  storageMiB: 65536,
  cpuCores: 8,
  online: true,
  cachedArtifactDigests: [],
  capabilities: {
    catalogExecution: true,
    privilegedContainers: false,
    hostNetwork: false,
    lanDiscovery: false,
    hostPaths: [],
    devices: [],
    dockerSocket: false,
  },
};

const healthyRuntime: CatalogRuntimeAdapter = {
  async execute() {
    return { state: 'healthy' };
  },
};

describe('durable catalog store', () => {
  it('survives adapter recreation with installation, operation, and recovery evidence intact', async () => {
    const release = loadValidationCatalog()[0];
    const service = new CatalogService([release], new DurableCatalogStore());
    const result = await service.install({
      plan: service.installPlan({
        id: release.release.id,
        release: release.release.release,
        applicationName: 'durable-fixture',
        target,
      }),
      applicationName: 'durable-fixture',
      actor: 'admin',
      runtime: healthyRuntime,
    });
    const recovery = service.recordRecoveryPoint({
      installationId: result.installation.id,
      actor: 'admin',
      status: 'verified',
      artifactReference: '/backups/durable-fixture.tar',
      artifactDigest: `sha256:${'d'.repeat(64)}`,
      verification: 'fixture restore verified',
    });

    const reopened = new CatalogService([release], new DurableCatalogStore());
    assert.equal(reopened.installation(result.installation.id).status, 'healthy');
    assert.equal(reopened.operations(result.installation.id)[0].status, 'succeeded');
    assert.equal(reopened.recoveryPoints(result.installation.id)[0].id, recovery.id);
  });

  it('rolls back an entire SQLite catalog transaction on conflict', () => {
    const durable = new DurableCatalogStore();
    const existing = durable.read((transaction) => transaction.listInstallations()[0]);
    assert.ok(existing);
    assert.throws(
      () =>
        durable.transaction((transaction) => {
          transaction.putInstallation(
            {
              ...existing,
              id: 'should-not-persist',
              applicationName: 'should-not-persist',
            },
            null,
          );
          transaction.putInstallation({ ...existing, revision: existing.revision + 1 }, 999);
        }),
      /revision changed/,
    );
    assert.equal(
      durable.read((transaction) => transaction.getInstallation('should-not-persist')),
      undefined,
    );
  });

  it('promotes a local catalog revision only after the graph executor reports healthy', async () => {
    let converged = 0;
    let removed = 0;
    const executor = {
      async converge(context: GraphExecutorContext) {
        converged += 1;
        return {
          applicationId: context.applicationId,
          releaseDigest: context.runtime.execution.specDigest,
          configurationDigest: context.runtime.configurationDigest,
          network: 'catalog-test-network',
          primaryPort: 43123,
          primaryContainerId: 'catalog-test-container',
          primaryContainerName: 'catalog-test-container',
          instances: [],
        };
      },
      async remove() {
        removed += 1;
      },
    };
    const release = loadValidationCatalog()[0];
    const service = new CatalogService([release], new DurableCatalogStore());
    const runtime = new DeployLocalCatalogRuntime({ executor, stageOnly: false });
    const installed = await service.install({
      plan: service.installPlan({
        id: release.release.id,
        release: release.release.release,
        applicationName: 'physical-fixture',
        target,
      }),
      applicationName: 'physical-fixture',
      actor: 'admin',
      runtime,
    });
    assert.equal(converged, 1);
    assert.equal(installed.installation.status, 'healthy');
    const deployment = storeModule.getDeployment('physical-fixture');
    assert.equal(deployment?.status, 'running');
    assert.equal(deployment?.activeSpecDigest, installed.installation.currentSpecDigest);
    assert.equal(deployment?.port, 43123);

    const uninstalled = await service.uninstall({
      plan: service.uninstallPlan(installed.installation.id, true),
      retainData: true,
      expectedRevision: installed.installation.revision,
      actor: 'admin',
      runtime,
    });
    assert.equal(removed, 1);
    assert.equal(uninstalled.installation.status, 'uninstalled');
    assert.equal(uninstalled.installation.dataRetained, true);
    assert.equal(storeModule.getDeployment('physical-fixture')?.status, 'stopped');
  });

  it('carries a signed PostgreSQL successor through recovery, upgrade, rollback, and removal on the ordinary graph path', async () => {
    const contexts: GraphExecutorContext[] = [];
    const recovered: Array<{
      context: GraphExecutorContext;
      artifact: { artifactReference: string; artifactDigest: `sha256:${string}` };
    }> = [];
    const removals: Array<{
      applicationId: string;
      siteId: string;
      managedVolumeResources?: readonly string[];
      removeInfrastructure?: boolean;
    }> = [];
    const recoveryDigest = `sha256:${'c'.repeat(64)}` as const;
    const executor = {
      async converge(context: GraphExecutorContext) {
        contexts.push(context);
        return {
          applicationId: context.applicationId,
          releaseDigest: context.runtime.execution.specDigest,
          configurationDigest: context.runtime.configurationDigest,
          network: 'catalog-lifecycle-network',
          primaryPort: 43124,
          primaryContainerId: 'catalog-lifecycle-container',
          primaryContainerName: 'catalog-lifecycle-container',
          instances: [],
        };
      },
      async createRecoveryPoint(context: GraphExecutorContext, destinationDirectory: string) {
        assert.equal(
          context.runtime.execution.components.postgres.profile?.profile,
          'deploy.local/postgres@1',
        );
        return {
          artifactReference: join(destinationDirectory, 'recovery-manifest.json'),
          artifactDigest: recoveryDigest,
          verification: 'cold-volume-archive:1:digest-and-tar-verified',
        };
      },
      async restoreRecoveryPoint(
        context: GraphExecutorContext,
        artifact: { artifactReference: string; artifactDigest: `sha256:${string}` },
      ) {
        recovered.push({ context, artifact });
      },
      async remove(input: (typeof removals)[number]) {
        removals.push(input);
      },
    };
    const releases = loadValidationCatalog().filter(
      (release) => release.release.id === 'postgres-service-graph-fixture',
    );
    const initial = releases.find((release) => release.release.release === '1.0.0-validation.1')!;
    const successor = releases.find((release) => release.release.release === '1.1.0-validation.1')!;
    const service = new CatalogService(releases, new DurableCatalogStore());
    const runtime = new DeployLocalCatalogRuntime({ executor, stageOnly: false });
    const answers = { 'worker-token': 'catalog-lifecycle-secret' };

    const installed = await service.install({
      plan: service.installPlan({
        id: initial.release.id,
        release: initial.release.release,
        applicationName: 'catalog-postgres-lifecycle',
        target,
        answers,
      }),
      applicationName: 'catalog-postgres-lifecycle',
      actor: 'admin',
      runtime,
      answers,
    });
    assert.equal(installed.installation.status, 'healthy');
    assert.equal(contexts[0]?.runtime.execution.components.web.desiredInstances, 2);
    assert.deepEqual(Object.keys(contexts[0]?.runtime.spec.jobs ?? {}), ['migrate']);
    assert.deepEqual(contexts[0]?.runtime.execution.components.postgres.profile?.capabilities, [
      'provision',
      'generated-bindings',
      'health',
      'backup',
      'restore',
      'upgrade',
    ]);

    const recovery = await service.createRecoveryPoint({
      installationId: installed.installation.id,
      actor: 'admin',
      runtime,
    });
    assert.equal(recovery.status, 'verified');
    assert.equal(recovery.specDigest, installed.installation.currentSpecDigest);
    assert.equal(recovery.artifactDigest, recoveryDigest);

    const upgradePlan = service.upgradePlan({
      installationId: installed.installation.id,
      toRelease: successor.release.release,
      target,
      answers,
    });
    assert.equal(upgradePlan.ready, true);
    assert.ok(upgradePlan.steps.some((step) => step.id === 'migration-migrate'));
    const upgraded = await service.upgrade({
      plan: upgradePlan,
      expectedRevision: installed.installation.revision,
      actor: 'admin',
      runtime,
      answers,
      recoveryPointId: recovery.id,
    });
    assert.equal(upgraded.installation.release, successor.release.release);
    assert.equal(upgraded.installation.blueprintDigest, successor.release.contentDigest);
    assert.equal(contexts.at(-1)?.runtime.execution.components.web.desiredInstances, 3);
    assert.equal(recovered.length, 0, 'upgrade retains recovery evidence without restoring it');

    const rolledBack = await service.rollback({
      plan: service.rollbackPlan(upgraded.installation.id, recovery.id),
      recoveryPointId: recovery.id,
      expectedRevision: upgraded.installation.revision,
      actor: 'admin',
      runtime,
    });
    assert.equal(rolledBack.installation.release, initial.release.release);
    assert.equal(rolledBack.installation.blueprintDigest, initial.release.contentDigest);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.artifact.artifactDigest, recoveryDigest);
    assert.equal(recovered[0]?.context.runtime.execution.components.web.desiredInstances, 2);

    const uninstalled = await service.uninstall({
      plan: service.uninstallPlan(rolledBack.installation.id, false),
      retainData: false,
      recoveryPointId: recovery.id,
      expectedRevision: rolledBack.installation.revision,
      actor: 'admin',
      runtime,
    });
    assert.equal(uninstalled.installation.status, 'uninstalled');
    assert.equal(uninstalled.installation.dataRetained, false);
    assert.deepEqual(removals[0]?.managedVolumeResources, ['database']);
    assert.equal(removals[0]?.removeInfrastructure, true);
    assert.equal(storeModule.getDeployment('catalog-postgres-lifecycle'), null);
  });
});
