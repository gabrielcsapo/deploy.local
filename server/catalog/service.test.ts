import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleCatalogRequest } from './handler.ts';
import { loadValidationCatalog } from './fixtures.ts';
import {
  planCatalogDetach,
  planCatalogDerive,
  planCatalogInstall,
  planCatalogUpgrade,
} from './planner.ts';
import { preflightCatalogInstall } from './preflight.ts';
import { CatalogService } from './service.ts';
import type { CatalogRuntimeAdapter, CatalogRuntimeRequest } from './service.ts';
import { CatalogStoreConflictError, InMemoryCatalogStore } from './store.ts';
import type {
  CatalogInstallation,
  CatalogTargetProfile,
  ValidatedCatalogRelease,
} from './types.ts';

const capableTarget: CatalogTargetProfile = {
  siteId: 'home',
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
    privilegedContainers: true,
    hostNetwork: true,
    lanDiscovery: true,
    hostPaths: ['/run/dbus'],
    devices: ['/dev/serial/by-id/radio'],
    dockerSocket: false,
  },
};

describe('catalog preflight, plans, store, and handler', () => {
  it('admits resolved validation artifacts without overstating evidence and redacts secrets', () => {
    const fixture = loadValidationCatalog()[2];
    const result = preflightCatalogInstall({
      release: fixture,
      applicationName: 'fixture',
      target: capableTarget,
      answers: { 'worker-token': 'do-not-return-this' },
    });
    assert.equal(result.ready, true);
    assert.equal(result.answerState['worker-token'].configured, true);
    assert.equal('displayValue' in result.answerState['worker-token'], false);
    assert.doesNotMatch(JSON.stringify(result), /do-not-return-this/);
    assert.ok(
      result.findings.some(
        (finding) =>
          finding.id === 'release-validation-evidence-incomplete' && finding.severity === 'warning',
      ),
    );
    assert.equal(
      result.findings.some((finding) => finding.dimension === 'artifact'),
      false,
    );
  });

  it('separates target, security, offline, suitcase, and reconciliation evidence', () => {
    const homeAssistant = loadValidationCatalog()[1];
    const compatible = preflightCatalogInstall({
      release: homeAssistant,
      applicationName: 'home-assistant',
      target: capableTarget,
    });
    assert.equal(compatible.ready, true);
    const result = preflightCatalogInstall({
      release: homeAssistant,
      applicationName: 'home-assistant',
      target: {
        ...capableTarget,
        deployLocalVersion: '2.0.0',
        operatingSystem: 'darwin',
        engine: 'docker-desktop',
        online: false,
        capabilities: {
          ...capableTarget.capabilities,
          privilegedContainers: false,
          hostNetwork: false,
          lanDiscovery: false,
        },
      },
    });
    assert.equal(result.ready, false);
    assert.ok(result.findings.some((finding) => finding.id === 'target-operating-system'));
    assert.ok(result.findings.some((finding) => finding.id === 'target-deploy-local-version'));
    assert.ok(result.findings.some((finding) => finding.id === 'target-container-engine'));
    assert.ok(result.findings.some((finding) => finding.dimension === 'security'));
    assert.ok(result.findings.some((finding) => finding.dimension === 'offline'));
    assert.equal(homeAssistant.release.compatibility.promises.suitcase, 'not-supported');
    assert.equal(homeAssistant.release.compatibility.promises.reconciliation, 'not-supported');

    const suitcaseBlocked = preflightCatalogInstall({
      release: homeAssistant,
      applicationName: 'home-assistant-suitcase',
      target: { ...capableTarget, siteKind: 'suitcase' },
    });
    assert.equal(suitcaseBlocked.ready, false);
    assert.ok(
      suitcaseBlocked.findings.some((finding) => finding.id === 'release-suitcase-not-supported'),
    );

    const portableUnknown = preflightCatalogInstall({
      release: loadValidationCatalog()[0],
      applicationName: 'portable-volume-app',
      target: { ...capableTarget, siteKind: 'suitcase' },
    });
    assert.equal(portableUnknown.ready, true);
    assert.ok(
      portableUnknown.findings.some(
        (finding) => finding.id === 'release-suitcase-evidence-unknown',
      ),
    );
  });

  it('plans install without mutation and preserves runtime/data for detach and derive', () => {
    const release = supportedClone(loadValidationCatalog()[0]);
    const store = new InMemoryCatalogStore();
    const service = new CatalogService([release], store);
    const installPlan = planCatalogInstall({
      release,
      applicationName: 'notes',
      target: capableTarget,
    });
    assert.equal(installPlan.ready, true);
    assert.equal(installPlan.changePlan.source, 'catalog');
    assert.equal(installPlan.changePlan.impacts.capacity.currentInstances, 0);
    assert.ok(installPlan.changePlan.impacts.capacity.desiredInstances > 0);
    assert.equal(
      store.read((transaction) => transaction.listInstallations().length),
      0,
    );
    const installation = service.commitHealthyInstall({
      plan: installPlan,
      applicationName: 'notes',
      runtimeHealthy: true,
      now: '2026-08-08T00:00:00.000Z',
    });
    assert.equal(installation.mode, 'managed');

    const detach = planCatalogDetach({ installation, current: release });
    const derive = planCatalogDerive({
      installation,
      current: release,
      localBlueprintId: 'my-notes',
    });
    assert.equal(detach.destructive, false);
    assert.equal(derive.destructive, false);
    assert.deepEqual(
      detach.normalizedSpec,
      release.normalizedSpec,
      'planner recompiles but semantics remain',
    );
    assert.match(detach.note, /preserves runtime and data/);
    assert.match(derive.note, /derived blueprint digest/);

    const drifted = {
      ...installation,
      currentSpecDigest: 'sha256:drifted',
      driftedAddresses: ['/metadata'],
    };
    const missingGraph = planCatalogDetach({ installation: drifted, current: release });
    assert.equal(missingGraph.ready, false);
    assert.ok(missingGraph.blockers.some((finding) => finding.id === 'current-graph-required'));
    const exactGraph = planCatalogDetach({
      installation: drifted,
      current: release,
      currentSpec: release.normalizedSpec,
    });
    assert.equal(exactGraph.ready, true);
  });

  it('blocks unsupported drift and models recovery/migration upgrade gates', () => {
    const current = supportedClone(loadValidationCatalog()[2]);
    const target = supportedClone(current);
    target.release.release = '1.1.0';
    target.release.upgrades = [
      {
        fromRelease: current.release.release,
        recoveryPointRequired: true,
        rollback: 'supported',
        migrationJobs: ['migrate'],
        notes: 'Fixture upgrade',
      },
    ];
    const installation = installationFor(current, ['/components/postgres/image']);
    const blocked = planCatalogUpgrade({
      installation,
      current,
      target,
      preflight: { target: capableTarget, answers: { 'worker-token': 'secret' } },
    });
    assert.equal(blocked.ready, false);
    assert.ok(blocked.blockers.some((finding) => finding.id === 'unsupported-drift'));

    const ready = planCatalogUpgrade({
      installation: { ...installation, driftedAddresses: [] },
      current,
      target,
      preflight: { target: capableTarget, answers: { 'worker-token': 'secret' } },
    });
    assert.equal(ready.ready, true);
    assert.equal(ready.destructive, true);
    assert.equal(ready.changePlan.source, 'catalog');
    assert.ok(ready.steps.some((step) => step.phase === 'recovery-point'));
    assert.ok(ready.steps.some((step) => step.phase === 'migrate'));
  });

  it('rolls back failed store transactions and enforces optimistic revisions', () => {
    const store = new InMemoryCatalogStore();
    const release = supportedClone(loadValidationCatalog()[0]);
    const installation = installationFor(release, []);
    assert.throws(
      () =>
        store.transaction((transaction) => {
          transaction.putInstallation(installation, null);
          throw new Error('abort');
        }),
      /abort/,
    );
    assert.equal(
      store.read((transaction) => transaction.listInstallations().length),
      0,
    );
    store.transaction((transaction) => transaction.putInstallation(installation, null));
    assert.throws(
      () =>
        store.transaction((transaction) =>
          transaction.putInstallation({ ...installation, revision: 2 }, 99),
        ),
      CatalogStoreConflictError,
    );
    assert.equal(
      store.read((transaction) => transaction.getInstallation(installation.id)?.revision),
      1,
    );
  });

  it('exposes an admin-only mountable browse/detail/preflight/plan/import handler', async () => {
    const service = new CatalogService(loadValidationCatalog(), new InMemoryCatalogStore());
    const denied = await handleCatalogRequest(service, {
      method: 'GET',
      pathname: '/catalog',
      actor: { username: 'reader', role: 'user' },
    });
    assert.equal(denied.status, 403);

    const browse = await handleCatalogRequest(service, {
      method: 'GET',
      pathname: '/catalog?query=assistant',
      actor: { username: 'admin', role: 'admin' },
    });
    assert.equal(browse.status, 200);
    assert.equal((browse.body as { releases: unknown[] }).releases.length, 1);

    const detail = await handleCatalogRequest(service, {
      method: 'GET',
      pathname: '/catalog/postgres-service-graph-fixture/1.0.0-validation.1',
      actor: { username: 'admin', role: 'admin' },
    });
    assert.equal(detail.status, 200);

    const preflight = await handleCatalogRequest(service, {
      method: 'POST',
      pathname: '/catalog/postgres-service-graph-fixture/1.0.0-validation.1/preflight',
      body: {
        applicationName: 'fixture',
        target: capableTarget,
        answers: { 'worker-token': 'never-return-this' },
      },
      actor: { username: 'admin', role: 'admin' },
    });
    assert.equal(preflight.status, 200);
    assert.doesNotMatch(JSON.stringify(preflight.body), /never-return-this/);

    const installPlan = await handleCatalogRequest(service, {
      method: 'POST',
      pathname: '/catalog/volume-app-fixture/1.0.0-validation.1/install-plan',
      body: { applicationName: 'volume-app', target: capableTarget },
      actor: { username: 'admin', role: 'admin' },
    });
    assert.equal(installPlan.status, 200);
    assert.equal((installPlan.body as { operation: string }).operation, 'install');

    const compose = await handleCatalogRequest(service, {
      method: 'POST',
      pathname: '/catalog/compose-import',
      body: {
        source: `services:\n  web:\n    image: example.invalid/app@sha256:${'a'.repeat(64)}\n`,
      },
      actor: { username: 'admin', role: 'admin' },
    });
    assert.equal(compose.status, 200);
  });

  it('executes detach and derive ownership changes without mutating runtime or data', async () => {
    const release = loadValidationCatalog()[0];
    const service = new CatalogService([release], new InMemoryCatalogStore());
    const install = (applicationName: string) =>
      service.commitHealthyInstall({
        plan: service.installPlan({
          id: release.release.id,
          release: release.release.release,
          applicationName,
          target: capableTarget,
        }),
        applicationName,
        runtimeHealthy: true,
      });
    const detached = install('detached-volume');
    const detachedResponse = await handleCatalogRequest(service, {
      method: 'POST',
      pathname: `/catalog/installations/${detached.id}/detach`,
      body: { expectedRevision: detached.revision },
      actor: { username: 'admin', role: 'admin' },
    });
    assert.equal(detachedResponse.status, 200);
    assert.equal((detachedResponse.body as CatalogInstallation).mode, 'detached');

    const derived = install('derived-volume');
    const derivedResponse = await handleCatalogRequest(service, {
      method: 'POST',
      pathname: `/catalog/installations/${derived.id}/derive`,
      body: { expectedRevision: derived.revision, localBlueprintId: 'my.volume-app' },
      actor: { username: 'admin', role: 'admin' },
    });
    assert.equal(derivedResponse.status, 200);
    assert.equal((derivedResponse.body as CatalogInstallation).mode, 'derived');
    assert.equal((derivedResponse.body as CatalogInstallation).localBlueprintId, 'my.volume-app');
  });

  it('exposes verified successor upgrade and rollback through the admin handler', async () => {
    const releases = loadValidationCatalog().filter(
      (release) => release.release.id === 'volume-app-fixture',
    );
    const initial = releases.find((release) => release.release.release === '1.0.0-validation.1')!;
    const successor = releases.find((release) => release.release.release === '1.1.0-validation.1')!;
    const service = new CatalogService(releases, new InMemoryCatalogStore());
    const runtime = new ScriptedRuntime(['healthy', 'healthy', 'healthy', 'healthy']);
    const actor = { username: 'admin', role: 'admin' } as const;
    const installedResponse = await handleCatalogRequest(
      service,
      {
        method: 'POST',
        pathname: `/catalog/${initial.release.id}/${initial.release.release}/install`,
        body: { applicationName: 'handler-lifecycle', target: capableTarget },
        actor,
      },
      runtime,
    );
    assert.equal(installedResponse.status, 201);
    const installed = installedResponse.body as {
      installation: CatalogInstallation;
      operation: { status: string };
    };
    assert.equal(installed.operation.status, 'succeeded');

    const recoveryResponse = await handleCatalogRequest(
      service,
      {
        method: 'POST',
        pathname: `/catalog/installations/${installed.installation.id}/recovery-points`,
        body: {},
        actor,
      },
      runtime,
    );
    assert.equal(recoveryResponse.status, 201);
    const recovery = recoveryResponse.body as { id: string; status: string };
    assert.equal(recovery.status, 'verified');

    const upgradePlanResponse = await handleCatalogRequest(service, {
      method: 'POST',
      pathname: `/catalog/installations/${installed.installation.id}/upgrade-plan`,
      body: { toRelease: successor.release.release, target: capableTarget },
      actor,
    });
    assert.equal(upgradePlanResponse.status, 200);
    assert.equal((upgradePlanResponse.body as { ready: boolean }).ready, true);
    const upgradedResponse = await handleCatalogRequest(
      service,
      {
        method: 'POST',
        pathname: `/catalog/installations/${installed.installation.id}/upgrade`,
        body: {
          toRelease: successor.release.release,
          target: capableTarget,
          expectedRevision: installed.installation.revision,
          recoveryPointId: recovery.id,
        },
        actor,
      },
      runtime,
    );
    assert.equal(upgradedResponse.status, 200);
    const upgraded = upgradedResponse.body as { installation: CatalogInstallation };
    assert.equal(upgraded.installation.release, successor.release.release);
    assert.equal(upgraded.installation.blueprintDigest, successor.release.contentDigest);

    const rollbackPlanResponse = await handleCatalogRequest(service, {
      method: 'POST',
      pathname: `/catalog/installations/${installed.installation.id}/rollback-plan`,
      body: { recoveryPointId: recovery.id },
      actor,
    });
    assert.equal(rollbackPlanResponse.status, 200);
    assert.equal((rollbackPlanResponse.body as { ready: boolean }).ready, true);
    const rolledBackResponse = await handleCatalogRequest(
      service,
      {
        method: 'POST',
        pathname: `/catalog/installations/${installed.installation.id}/rollback`,
        body: {
          expectedRevision: upgraded.installation.revision,
          recoveryPointId: recovery.id,
        },
        actor,
      },
      runtime,
    );
    assert.equal(rolledBackResponse.status, 200);
    const rolledBack = rolledBackResponse.body as { installation: CatalogInstallation };
    assert.equal(rolledBack.installation.release, initial.release.release);

    const removedResponse = await handleCatalogRequest(
      service,
      {
        method: 'POST',
        pathname: `/catalog/installations/${installed.installation.id}/uninstall`,
        body: {
          retainData: false,
          expectedRevision: rolledBack.installation.revision,
          recoveryPointId: recovery.id,
        },
        actor,
      },
      runtime,
    );
    assert.equal(removedResponse.status, 200);
    assert.equal(
      (removedResponse.body as { installation: CatalogInstallation }).installation.status,
      'uninstalled',
    );
  });

  it('journals failed installs and retries the same intent without losing attempt history', async () => {
    const release = loadValidationCatalog()[0];
    const service = new CatalogService([release], new InMemoryCatalogStore());
    const plan = service.installPlan({
      id: release.release.id,
      release: release.release.release,
      applicationName: 'retry-fixture',
      target: capableTarget,
    });
    const runtime = new ScriptedRuntime(['failure', 'healthy']);
    await assert.rejects(
      service.install({
        plan,
        applicationName: 'retry-fixture',
        actor: 'admin',
        runtime,
      }),
      /scripted runtime failure/,
    );
    const failed = service.installations()[0];
    assert.equal(failed.status, 'failed');
    const retried = await service.retry({
      installationId: failed.id,
      expectedRevision: failed.revision,
      actor: 'admin',
      runtime,
    });
    assert.equal(retried.installation.status, 'healthy');
    assert.equal(retried.operation.attempt, 2);
    assert.equal(service.operations(failed.id).length, 1, 'retry resumes the durable intent');
  });

  it('requires verified recovery before upgrades, rollback, and delete-data uninstall', async () => {
    const current = loadValidationCatalog()[2];
    const target = structuredClone(current);
    target.release.release = '1.1.0';
    target.release.contentDigest = `sha256:${'b'.repeat(64)}`;
    target.release.upgrades = [
      {
        fromRelease: current.release.release,
        recoveryPointRequired: true,
        rollback: 'supported',
        migrationJobs: ['migrate'],
        notes: 'Lifecycle test',
      },
    ];
    const service = new CatalogService([current, target], new InMemoryCatalogStore());
    const runtime = new ScriptedRuntime(['healthy', 'healthy', 'healthy', 'healthy']);
    const installed = await service.install({
      plan: service.installPlan({
        id: current.release.id,
        release: current.release.release,
        applicationName: 'database-fixture',
        target: capableTarget,
        answers: { 'worker-token': 'secret' },
      }),
      applicationName: 'database-fixture',
      actor: 'admin',
      runtime,
      answers: { 'worker-token': 'secret' },
    });
    const upgradePlan = service.upgradePlan({
      installationId: installed.installation.id,
      toRelease: target.release.release,
      target: capableTarget,
      answers: { 'worker-token': 'secret' },
    });
    await assert.rejects(
      service.upgrade({
        plan: upgradePlan,
        expectedRevision: installed.installation.revision,
        actor: 'admin',
        runtime,
        answers: { 'worker-token': 'secret' },
      }),
      /verified recovery point is required/,
    );
    const recovery = await service.createRecoveryPoint({
      installationId: installed.installation.id,
      actor: 'admin',
      runtime,
    });
    const upgraded = await service.upgrade({
      plan: upgradePlan,
      expectedRevision: installed.installation.revision,
      actor: 'admin',
      runtime,
      answers: { 'worker-token': 'secret' },
      recoveryPointId: recovery.id,
    });
    assert.equal(upgraded.installation.release, '1.1.0');

    const rolledBack = await service.rollback({
      plan: service.rollbackPlan(upgraded.installation.id, recovery.id),
      recoveryPointId: recovery.id,
      expectedRevision: upgraded.installation.revision,
      actor: 'admin',
      runtime,
    });
    assert.equal(rolledBack.installation.release, current.release.release);

    const removed = await service.uninstall({
      plan: service.uninstallPlan(rolledBack.installation.id, false),
      retainData: false,
      recoveryPointId: recovery.id,
      expectedRevision: rolledBack.installation.revision,
      actor: 'admin',
      runtime,
    });
    assert.equal(removed.installation.status, 'uninstalled');
    assert.equal(removed.installation.dataRetained, false);
  });

  it('allows retain-data uninstall without a recovery artifact and records the decision', async () => {
    const release = loadValidationCatalog()[0];
    const service = new CatalogService([release], new InMemoryCatalogStore());
    const runtime = new ScriptedRuntime(['healthy', 'healthy']);
    const installed = await service.install({
      plan: service.installPlan({
        id: release.release.id,
        release: release.release.release,
        applicationName: 'retained-fixture',
        target: capableTarget,
      }),
      applicationName: 'retained-fixture',
      actor: 'admin',
      runtime,
    });
    await assert.rejects(
      service.uninstall({
        plan: service.uninstallPlan(installed.installation.id, false),
        retainData: false,
        expectedRevision: installed.installation.revision,
        actor: 'admin',
        runtime,
      }),
      /verified recovery point is required/,
    );
    const retainedPlan = service.uninstallPlan(installed.installation.id, true);
    assert.equal(retainedPlan.changePlan.impacts.data.effect, 'retain');
    assert.equal(retainedPlan.changePlan.destructive, false);
    const retained = await service.uninstall({
      plan: retainedPlan,
      retainData: true,
      expectedRevision: installed.installation.revision,
      actor: 'admin',
      runtime,
    });
    assert.equal(retained.installation.status, 'uninstalled');
    assert.equal(retained.installation.dataRetained, true);
  });

  it('keeps a remote recovery point pending until the target reports verified evidence', async () => {
    const release = loadValidationCatalog()[0];
    const service = new CatalogService([release], new InMemoryCatalogStore());
    let recoveryReady = false;
    const runtime: CatalogRuntimeAdapter = {
      async execute() {
        return { state: 'healthy' };
      },
      async createRecoveryPoint() {
        return { state: 'pending' };
      },
      async recoveryCompletion() {
        return recoveryReady
          ? {
              state: 'verified',
              artifactReference: '/target/recovery/manifest.json',
              artifactDigest: `sha256:${'e'.repeat(64)}` as const,
              verification: 'target-volume-archive:digest-and-tar-verified',
            }
          : { state: 'pending' };
      },
    };
    const installed = await service.install({
      plan: service.installPlan({
        id: release.release.id,
        release: release.release.release,
        applicationName: 'remote-recovery-fixture',
        target: capableTarget,
      }),
      applicationName: 'remote-recovery-fixture',
      actor: 'admin',
      runtime,
    });
    const recovery = await service.createRecoveryPoint({
      installationId: installed.installation.id,
      actor: 'admin',
      runtime,
    });
    assert.equal(recovery.status, 'pending');
    assert.equal(await service.reconcileRuntime(runtime), 0);

    recoveryReady = true;
    assert.equal(await service.reconcileRuntime(runtime), 1);
    assert.equal(service.recoveryPoints(installed.installation.id)[0].status, 'verified');
    assert.match(
      service.recoveryPoints(installed.installation.id)[0].artifactDigest ?? '',
      /^sha256:/,
    );
  });
});

class ScriptedRuntime implements CatalogRuntimeAdapter {
  readonly outcomes: Array<'healthy' | 'accepted' | 'failure'>;

  constructor(outcomes: Array<'healthy' | 'accepted' | 'failure'>) {
    this.outcomes = outcomes;
  }

  async execute(_request: CatalogRuntimeRequest) {
    const outcome = this.outcomes.shift() ?? 'healthy';
    if (outcome === 'failure') throw new Error('scripted runtime failure');
    return { state: outcome } as const;
  }

  async createRecoveryPoint() {
    return {
      artifactReference: '/backups/database-fixture/recovery-manifest.json',
      artifactDigest: `sha256:${'c'.repeat(64)}` as const,
      verification: 'cold-volume-archive:1:digest-and-tar-verified',
    };
  }
}

function supportedClone(source: ValidatedCatalogRelease): ValidatedCatalogRelease {
  const clone = structuredClone(source);
  clone.release.support.stage = 'supported';
  clone.release.artifacts = clone.release.artifacts.map((artifact) => ({
    ...artifact,
    verification: 'resolved',
  }));
  clone.release.compatibility.promises.install = 'verified';
  return clone;
}

function installationFor(
  release: ValidatedCatalogRelease,
  driftedAddresses: string[],
): CatalogInstallation {
  return {
    id: 'installation-1',
    applicationName: 'fixture',
    blueprintId: release.release.id,
    release: release.release.release,
    blueprintDigest: release.release.contentDigest,
    installedSpecDigest: 'sha256:installed',
    currentSpecDigest: 'sha256:installed',
    siteId: 'home',
    mode: 'managed',
    status: 'healthy',
    revision: 1,
    driftedAddresses,
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
  };
}
