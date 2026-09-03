import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
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
import { describe, it } from 'node:test';
import {
  ApplicationGraphExecutor,
  type ProfileArtifactStore,
} from './application-graph-executor.ts';
import { buildApplicationGraphRuntime } from './application-runtime.ts';
import { compileDeployYaml } from './application-spec.ts';
import type {
  GraphCommandResult,
  GraphContainerCreateRequest,
  GraphContainerInspection,
  GraphDockerAdapter,
  GraphHealthProbe,
} from './graph-docker-adapter.ts';
import type {
  ComponentInstanceRow,
  ComponentJobExecutionRow,
  ComponentProfileOperationRow,
  ComponentProfileVolumeBindingRow,
  ComponentServiceRow,
  GraphRuntimeStateStore,
  ReadyEndpointInput,
} from './graph-runtime-store.ts';

const MANIFEST = `
apiVersion: deploy.local/v1
kind: Application
metadata:
  name: family
components:
  database:
    image: postgres:16.4
    role: service
    profile: deploy.local/postgres@1
    interfaces:
      postgres:
        port: 5432
        protocol: postgres
    mounts:
      /var/lib/postgresql/data:
        resource: database-data
  web:
    image: nginx:1.27
    role: web
    instances: 2
    capacity:
      memoryBytes: 536870912
      cpuMillicores: 750
    interfaces:
      http:
        port: 8080
        protocol: http
    environment:
      DATABASE_URL:
        from: database.postgres
    health:
      interface: http
      path: /health
resources:
  database-data:
    type: volume
    durability: durable
    dataRole: database
    access: singleWriter
    consistencyGroup: database-state
routes:
  public:
    to: web.http
jobs:
  migrate:
    component: web
    command: [migrate, up]
    execution: perSite
    beforeTraffic: true
`;

const RECOVERY_CONTRACT_MANIFEST = MANIFEST.replace(
  'routes:\n',
  `  web-cache:
    type: volume
    durability: ephemeral
    dataRole: cache
    access: multipleReaders
    backup:
      policy: exclude
routes:
`,
);

const HOST_NETWORK_MANIFEST = `
apiVersion: deploy.local/v1
kind: Application
metadata:
  name: home-assistant
components:
  home-assistant:
    image: home-assistant:test
    role: web
    interfaces:
      http:
        port: 8123
        protocol: http
    health:
      interface: http
      path: /
    runtime:
      networkMode: host
      privileged: true
      devices:
        - hostPath: /dev/ttyUSB0
          containerPath: /dev/zigbee
          permissions: rw
routes:
  home:
    to: home-assistant.http
`;

const SCOPED_CONFIGURATION_MANIFEST = `
apiVersion: deploy.local/v1
kind: Application
metadata:
  name: family
configuration:
  apiToken:
    type: secret
    required: true
  policyDocument:
    type: file
    required: true
components:
  api:
    image: busybox:1.37
    role: worker
    command: [sleep, infinity]
    environment:
      API_TOKEN:
        from: configuration.apiToken
    configurationFiles:
      /run/deploy/policy.json:
        from: configuration.policyDocument
  scheduler:
    image: busybox:1.37
    role: worker
    command: [sleep, infinity]
`;

const BUILD_MANIFEST = `
apiVersion: deploy.local/v1
kind: Application
metadata:
  name: family
components:
  web:
    build:
      context: .
      dockerfile: Dockerfile
    role: web
`;

describe('ApplicationGraphExecutor', () => {
  it('proves the exact source/spec build by forcing Docker networking off', async () => {
    const docker = new FakeGraphDocker();
    const executor = new ApplicationGraphExecutor({ docker, state: new MemoryGraphState() });
    const graphContext = context(runtime(BUILD_MANIFEST));
    const sourceDigest = `sha256:${'a'.repeat(64)}` as const;

    const proof = await executor.proveOfflineBuild(graphContext, sourceDigest);

    assert.equal(proof.sourceArtifactDigest, sourceDigest);
    assert.equal(proof.specDigest, graphContext.runtime.execution.specDigest);
    assert.equal(proof.networkMode, 'none');
    assert.deepEqual(
      proof.components.map((item) => item.component),
      ['web'],
    );
    assert.deepEqual(
      {
        forceBuild: docker.preparedImages[0]?.forceBuild,
        networkMode: docker.preparedImages[0]?.networkMode,
      },
      { forceBuild: true, networkMode: 'none' },
    );
    const differentSource = await executor.proveOfflineBuild(
      graphContext,
      `sha256:${'b'.repeat(64)}`,
    );
    assert.notEqual(differentSource.inputDigest, proof.inputDigest);
  });

  it('prepares every component image while unresolved configuration keeps runtime gated', async () => {
    const docker = new FakeGraphDocker();
    const executor = new ApplicationGraphExecutor({ docker, state: new MemoryGraphState() });
    const compiled = compileDeployYaml(SCOPED_CONFIGURATION_MANIFEST);
    const unresolved = buildApplicationGraphRuntime({
      applicationId: 'family-id',
      specDigest: compiled.digest,
      spec: compiled.spec,
      configuration: {
        digest: 'sha256:missing-configuration',
        values: {},
        missing: ['apiToken', 'policyDocument'],
      },
    });
    assert.equal(unresolved.ready, false);

    const prepared = await executor.prepare(context(unresolved));

    assert.deepEqual(
      prepared.components.map((component) => component.component),
      ['api', 'scheduler'],
    );
    assert.equal(docker.preparedImages.length, 2);
    assert.equal(docker.created.length, 0, 'configuration-gated components are not started');
    assert.equal(docker.networks.size, 0, 'build preparation creates no routable infrastructure');
  });

  it('materializes private siblings, fixed slots, profile bindings, jobs, and ready endpoints', async () => {
    const docker = new FakeGraphDocker();
    const state = new MemoryGraphState();
    const executor = new ApplicationGraphExecutor({ docker, state });

    const result = await executor.converge(context(runtime(MANIFEST)));

    assert.equal(result.instances.length, 3);
    assert.deepEqual(result.instances.map((instance) => instance.slotKey).sort(), [
      'family-id/database/1',
      'family-id/web/1',
      'family-id/web/2',
    ]);
    assert.equal(docker.networks.size, 1);
    assert.equal(docker.volumes.size, 1);
    assert.equal(docker.created.length, 3);
    assert.equal(docker.oneShots.length, 1);
    const database = docker.created.find(
      (request) => request.labels['deploy-sh.component'] === 'database',
    );
    assert.ok(database);
    assert.match(database.environment.POSTGRES_PASSWORD, /^[A-Za-z0-9_-]{40,}$/);
    const web = docker.created.find((request) => request.labels['deploy-sh.component'] === 'web');
    assert.ok(web);
    assert.equal(web.memoryLimit, '536870912b');
    assert.equal(web.cpuLimit, '0.75');
    assert.match(
      web.environment.DATABASE_URL,
      /^postgres:\/\/.+@database\.family-id\.internal:5432\//,
    );
    const published = state.activeEndpoints('family-id/web/http');
    assert.equal(published.length, 2);
    assert.ok(published.every((endpoint) => endpoint.host === '127.0.0.1'));

    await executor.converge(context(runtime(MANIFEST)));
    assert.equal(docker.created.length, 3, 'convergence reuses healthy fixed-slot instances');
    assert.equal(docker.oneShots.length, 1, 'successful per-site jobs are idempotent');
  });

  it('never infers writer-site job authority from the local execution site', async () => {
    const docker = new FakeGraphDocker();
    const state = new MemoryGraphState();
    const executor = new ApplicationGraphExecutor({ docker, state });
    const graphContext = context(
      runtime(MANIFEST.replace('execution: perSite', 'execution: writerSite')),
    );

    await assert.rejects(executor.converge(graphContext), /writer site is known/i);
    assert.equal(docker.oneShots.length, 0);

    const admitted = await executor.converge({ ...graphContext, writerSiteId: 'coordinator' });
    assert.equal(admitted.instances.length, 3);
    assert.equal(docker.oneShots.length, 1);
  });

  it('restarts one component and replaces one instance without recycling unrelated siblings', async () => {
    const docker = new FakeGraphDocker();
    const state = new MemoryGraphState();
    const executor = new ApplicationGraphExecutor({ docker, state });
    const graphContext = context(runtime(MANIFEST));
    const initial = await executor.converge(graphContext);
    const databaseId = initial.instances.find(
      (instance) => instance.componentKey === 'database',
    )!.id;
    const initialWebIds = initial.instances
      .filter((instance) => instance.componentKey === 'web')
      .map((instance) => instance.id)
      .sort();

    const restarted = await executor.restartComponent(graphContext, 'web');
    assert.equal(
      restarted.instances.find((instance) => instance.componentKey === 'database')!.id,
      databaseId,
      'rolling web restart preserves the database sibling',
    );
    const restartedWebIds = restarted.instances
      .filter((instance) => instance.componentKey === 'web')
      .map((instance) => instance.id)
      .sort();
    assert.notDeepEqual(restartedWebIds, initialWebIds);

    const replaceId = restartedWebIds[0]!;
    const replaced = await executor.replaceInstance(graphContext, replaceId);
    const finalWebIds = replaced.instances
      .filter((instance) => instance.componentKey === 'web')
      .map((instance) => instance.id)
      .sort();
    assert.equal(finalWebIds.includes(replaceId), false);
    assert.equal(
      finalWebIds.filter((id) => restartedWebIds.includes(id)).length,
      1,
      'the other fixed-slot web instance is reused',
    );
    assert.equal(
      replaced.instances.find((instance) => instance.componentKey === 'database')!.id,
      databaseId,
    );
  });

  it('rotates only components that consume a changed configuration value', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'deploy-component-configuration-'));
    const previousDataDirectory = process.env.DEPLOY_DATA_DIR;
    process.env.DEPLOY_DATA_DIR = directory;
    const docker = new FakeGraphDocker();
    const state = new MemoryGraphState();
    const executor = new ApplicationGraphExecutor({ docker, state });
    const initialRuntime = runtime(
      SCOPED_CONFIGURATION_MANIFEST,
      { apiToken: 'first-secret', policyDocument: '{"allow":true}' },
      'sha256:configuration-one',
    );
    const initial = await executor.converge(context(initialRuntime));
    const schedulerId = initial.instances.find(
      (instance) => instance.componentKey === 'scheduler',
    )!.id;
    const apiId = initial.instances.find((instance) => instance.componentKey === 'api')!.id;
    const apiRequest = docker.created.find(
      (request) => request.labels['deploy-sh.component'] === 'api',
    )!;
    const projectedFile = apiRequest.mounts.find(
      (mount) => mount.target === '/run/deploy/policy.json',
    );
    assert.ok(projectedFile);
    assert.equal(projectedFile.type, 'bind');
    assert.equal(projectedFile.readOnly, true);
    assert.equal(readFileSync(projectedFile.source, 'utf8'), '{"allow":true}');
    assert.equal(statSync(projectedFile.source).mode & 0o777, 0o600);

    try {
      const rotated = await executor.converge(
        context(
          runtime(
            SCOPED_CONFIGURATION_MANIFEST,
            { apiToken: 'second-secret', policyDocument: '{"allow":true}' },
            'sha256:configuration-two',
          ),
        ),
      );

      assert.equal(
        rotated.instances.find((instance) => instance.componentKey === 'scheduler')!.id,
        schedulerId,
        'an unrelated sibling keeps its fixed-slot identity',
      );
      assert.notEqual(
        rotated.instances.find((instance) => instance.componentKey === 'api')!.id,
        apiId,
        'the configuration consumer rolls to a fresh instance',
      );
      assert.equal(docker.created.length, 3);
    } finally {
      if (previousDataDirectory === undefined) delete process.env.DEPLOY_DATA_DIR;
      else process.env.DEPLOY_DATA_DIR = previousDataDirectory;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps the prior endpoint generation and database when a web rollout fails', async () => {
    const docker = new FakeGraphDocker();
    const state = new MemoryGraphState();
    const executor = new ApplicationGraphExecutor({ docker, state });
    await executor.converge(context(runtime(MANIFEST)));
    const previousEndpoints = state.activeEndpoints('family-id/web/http').map((item) => item.id);
    const databaseId = state
      .listInstances('family-id', 'coordinator', 'database')
      .find((item) => item.status === 'ready')?.id;

    docker.failNextHealthForComponent = 'web';
    await assert.rejects(
      executor.converge(context(runtime(MANIFEST.replace('nginx:1.27', 'nginx:1.28')))),
      /failed its health gate/,
    );

    assert.deepEqual(
      state.activeEndpoints('family-id/web/http').map((item) => item.id),
      previousEndpoints,
    );
    assert.equal(
      state
        .listInstances('family-id', 'coordinator', 'database')
        .find((item) => item.status === 'ready')?.id,
      databaseId,
      'an unchanged stateful dependency is not rolled with its consumer',
    );
    assert.equal(
      state
        .listInstances('family-id', 'coordinator', 'web')
        .filter((item) => item.status === 'ready').length,
      2,
    );
  });

  it('restarts existing siblings and records substituted PostgreSQL profile operations', async () => {
    const fixture = profileFixture();
    const { docker, state, executor, graphContext } = fixture;
    try {
      await executor.converge(graphContext);
      const createCount = docker.created.length;

      await executor.stop({ applicationId: 'family-id', siteId: 'coordinator' });
      await executor.converge(graphContext);
      assert.equal(docker.created.length, createCount);
      assert.ok(
        state
          .listInstances('family-id', 'coordinator')
          .every((instance) => instance.status === 'ready'),
      );

      const operation = await executor.executeProfileOperation(graphContext, {
        component: 'database',
        operation: 'logical-export',
      });
      assert.equal(operation.exitCode, 0);
      assert.match(docker.execCommands.at(-1)?.command.join(' ') ?? '', /pg_dump/);
      assert.match(
        docker.execCommands.at(-1)?.command.join(' ') ?? '',
        /\/tmp\/deploy-profile-backup\.dump/,
      );
      assert.match(operation.artifactDigest ?? '', /^sha256:[a-f0-9]{64}$/);
      const evidence = state.profileOperations.get(operation.id)!;
      assert.equal(evidence.status, 'succeeded');
      assert.equal(evidence.artifactDigest, operation.artifactDigest);
      assert.match(evidence.verification ?? '', /content-digest-verified/);
      assert.equal(evidence.sourceVolume, 'deploy-sh-family-id-database-data');
      assert.doesNotMatch(evidence.command, /family_owner|[A-Za-z0-9_-]{40,}/);
    } finally {
      fixture.cleanup();
    }
  });

  it('records dump failure without publishing a recovery artifact', async () => {
    const fixture = profileFixture();
    try {
      await fixture.executor.converge(fixture.graphContext);
      fixture.docker.failDump = true;
      await assert.rejects(
        fixture.executor.executeProfileOperation(fixture.graphContext, {
          component: 'database',
          operation: 'logical-export',
        }),
        /pg_dump failed/,
      );
      const operation = [...fixture.state.profileOperations.values()].at(-1)!;
      assert.equal(operation.status, 'failed');
      assert.equal(operation.artifactDigest, undefined);
      assert.equal(fixture.artifacts.records.size, 0);
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects a corrupt logical archive before the active database is stopped', async () => {
    const fixture = profileFixture();
    try {
      const initial = await fixture.executor.converge(fixture.graphContext);
      const database = initial.instances.find((item) => item.componentKey === 'database')!;
      const backup = await fixture.executor.executeProfileOperation(fixture.graphContext, {
        component: 'database',
        operation: 'logical-export',
      });
      fixture.artifacts.corrupt(backup.artifactDigest!);

      await assert.rejects(
        fixture.executor.executeProfileOperation(fixture.graphContext, {
          component: 'database',
          operation: 'verified-restore',
          artifactDigest: backup.artifactDigest,
        }),
        /digest verification/,
      );
      assert.equal(fixture.docker.containers.get(database.containerName)?.running, true);
      assert.equal(fixture.state.profileVolumeBindings.size, 0);
      assert.equal(fixture.docker.copiedToContainers.length, 0);
    } finally {
      fixture.cleanup();
    }
  });

  it('discards a fresh volume when pg_restore fails and leaves the old writer active', async () => {
    const fixture = profileFixture();
    try {
      const initial = await fixture.executor.converge(fixture.graphContext);
      const database = initial.instances.find((item) => item.componentKey === 'database')!;
      const backup = await fixture.executor.executeProfileOperation(fixture.graphContext, {
        component: 'database',
        operation: 'logical-export',
      });
      fixture.docker.failRestore = true;

      await assert.rejects(
        fixture.executor.executeProfileOperation(fixture.graphContext, {
          component: 'database',
          operation: 'verified-restore',
          artifactDigest: backup.artifactDigest,
        }),
        /pg_restore failed/,
      );
      assert.equal(fixture.docker.containers.get(database.containerName)?.running, true);
      assert.deepEqual([...fixture.docker.volumes], ['deploy-sh-family-id-database-data']);
      assert.equal(fixture.state.profileVolumeBindings.size, 0);
    } finally {
      fixture.cleanup();
    }
  });

  it('rolls back a staged provider when a dependent application health gate fails', async () => {
    const fixture = profileFixture();
    try {
      const initial = await fixture.executor.converge(fixture.graphContext);
      const database = initial.instances.find((item) => item.componentKey === 'database')!;
      const endpoints = fixture.state.activeEndpoints('family-id/web/http').map((item) => item.id);
      const backup = await fixture.executor.executeProfileOperation(fixture.graphContext, {
        component: 'database',
        operation: 'logical-export',
      });
      fixture.docker.failHealthForComponent = 'web';

      await assert.rejects(
        fixture.executor.executeProfileOperation(fixture.graphContext, {
          component: 'database',
          operation: 'verified-restore',
          artifactDigest: backup.artifactDigest,
        }),
        /failed its health gate/,
      );
      assert.equal(fixture.docker.containers.get(database.containerName)?.running, true);
      assert.equal(
        fixture.state.instances.get(database.id)?.status,
        'ready',
        'the old single writer is restarted after candidate admission fails',
      );
      assert.deepEqual(
        fixture.state.activeEndpoints('family-id/web/http').map((item) => item.id),
        endpoints,
      );
      assert.equal(fixture.state.profileVolumeBindings.size, 0);
      assert.deepEqual([...fixture.docker.volumes], ['deploy-sh-family-id-database-data']);
    } finally {
      fixture.cleanup();
    }
  });

  it('activates a verified fresh volume atomically and preserves the prior volume for rollback', async () => {
    const fixture = profileFixture();
    try {
      await fixture.executor.converge(fixture.graphContext);
      const backup = await fixture.executor.executeProfileOperation(fixture.graphContext, {
        component: 'database',
        operation: 'logical-export',
      });
      let activated = 0;
      const restored = await fixture.executor.executeProfileOperation(fixture.graphContext, {
        component: 'database',
        operation: 'verified-restore',
        artifactDigest: backup.artifactDigest,
        activationCommit: () => activated++,
        activationRollback: () => activated--,
      });

      assert.equal(activated, 1);
      assert.equal(restored.activeVolume?.includes('-profile-'), true);
      assert.equal(restored.rollbackVolume, 'deploy-sh-family-id-database-data');
      assert.ok(fixture.docker.volumes.has(restored.activeVolume!));
      assert.ok(fixture.docker.volumes.has(restored.rollbackVolume!));
      assert.equal(fixture.docker.copiedToContainers.length, 1);
      const binding = fixture.state.getProfileVolumeBinding({
        appId: 'family-id',
        siteId: 'coordinator',
        componentKey: 'database',
        resourceKey: 'database-data',
      })!;
      assert.equal(binding.activeProviderVolume, restored.activeVolume);
      assert.equal(binding.rollbackProviderVolume, restored.rollbackVolume);
      assert.equal(binding.artifactDigest, backup.artifactDigest);
      assert.match(restored.verification ?? '', /application-graph-health-verified/);
    } finally {
      fixture.cleanup();
    }
  });

  it('restores the old writer and provider binding when external revision activation fails', async () => {
    const fixture = profileFixture();
    try {
      const initial = await fixture.executor.converge(fixture.graphContext);
      const database = initial.instances.find((item) => item.componentKey === 'database')!;
      const backup = await fixture.executor.executeProfileOperation(fixture.graphContext, {
        component: 'database',
        operation: 'logical-export',
      });
      let rollbackAttempted = false;

      await assert.rejects(
        fixture.executor.executeProfileOperation(fixture.graphContext, {
          component: 'database',
          operation: 'verified-restore',
          artifactDigest: backup.artifactDigest,
          activationCommit: () => {
            throw new Error('revision compare-and-swap failed');
          },
          activationRollback: () => {
            rollbackAttempted = true;
          },
        }),
        /compare-and-swap failed/,
      );
      assert.equal(rollbackAttempted, true);
      assert.equal(fixture.state.profileVolumeBindings.size, 0);
      assert.equal(fixture.docker.containers.get(database.containerName)?.running, true);
      assert.deepEqual([...fixture.docker.volumes], ['deploy-sh-family-id-database-data']);
    } finally {
      fixture.cleanup();
    }
  });

  it('health-gates rollback before swapping the preserved provider back into service', async () => {
    const fixture = profileFixture();
    try {
      await fixture.executor.converge(fixture.graphContext);
      const backup = await fixture.executor.executeProfileOperation(fixture.graphContext, {
        component: 'database',
        operation: 'logical-export',
      });
      const restored = await fixture.executor.executeProfileOperation(fixture.graphContext, {
        component: 'database',
        operation: 'verified-restore',
        artifactDigest: backup.artifactDigest,
      });
      const rolledBack = await fixture.executor.executeProfileOperation(fixture.graphContext, {
        component: 'database',
        operation: 'rollback',
        targetContext: fixture.graphContext,
      });

      assert.equal(rolledBack.activeVolume, restored.rollbackVolume);
      assert.equal(rolledBack.rollbackVolume, restored.activeVolume);
      assert.ok(fixture.docker.volumes.has(restored.activeVolume!));
      assert.ok(fixture.docker.volumes.has(restored.rollbackVolume!));
      assert.match(rolledBack.verification ?? '', /graph-health-verified/);
    } finally {
      fixture.cleanup();
    }
  });

  it('refuses to manufacture an empty volume when preserved rollback data is missing', async () => {
    const fixture = profileFixture();
    try {
      await fixture.executor.converge(fixture.graphContext);
      const backup = await fixture.executor.executeProfileOperation(fixture.graphContext, {
        component: 'database',
        operation: 'logical-export',
      });
      const restored = await fixture.executor.executeProfileOperation(fixture.graphContext, {
        component: 'database',
        operation: 'verified-restore',
        artifactDigest: backup.artifactDigest,
      });
      fixture.docker.volumes.delete(restored.rollbackVolume!);

      await assert.rejects(
        fixture.executor.executeProfileOperation(fixture.graphContext, {
          component: 'database',
          operation: 'rollback',
          targetContext: fixture.graphContext,
        }),
        /rollback volume is missing/,
      );
      const binding = fixture.state.getProfileVolumeBinding({
        appId: 'family-id',
        siteId: 'coordinator',
        componentKey: 'database',
        resourceKey: 'database-data',
      });
      assert.equal(binding?.activeProviderVolume, restored.activeVolume);
    } finally {
      fixture.cleanup();
    }
  });

  it('blocks an ordinary PostgreSQL major change but admits the explicit backup-and-restore workflow', async () => {
    const fixture = profileFixture();
    try {
      await fixture.executor.converge(fixture.graphContext);
      const targetContext = context(runtime(MANIFEST.replace('postgres:16.4', 'postgres:17.4')));
      await assert.rejects(fixture.executor.converge(targetContext), /requires an explicit/);
      let activated = false;
      const upgraded = await fixture.executor.executeProfileOperation(fixture.graphContext, {
        component: 'database',
        operation: 'major-upgrade',
        targetContext,
        activationCommit: () => {
          activated = true;
        },
        activationRollback: () => {
          activated = false;
        },
      });

      assert.equal(activated, true);
      assert.equal(
        upgraded.materialization?.releaseDigest,
        targetContext.runtime.execution.specDigest,
      );
      assert.match(upgraded.artifactDigest ?? '', /^sha256:/);
      assert.ok(
        fixture.docker.created.some(
          (request) =>
            request.labels['deploy-sh.component'] === 'database' &&
            request.image === 'postgres:17.4' &&
            request.labels['deploy-sh.staged-restore'] !== 'true',
        ),
      );
      const migration = fixture.docker.oneShots.at(-1)!;
      assert.match(migration.environment.DATABASE_URL, /family_migration/);
    } finally {
      fixture.cleanup();
    }
  });

  it('materializes an admitted host-network component without private aliases or port publishing', async () => {
    const docker = new FakeGraphDocker();
    const state = new MemoryGraphState();
    const executor = new ApplicationGraphExecutor({ docker, state });

    const result = await executor.converge(context(runtime(HOST_NETWORK_MANIFEST)));

    assert.equal(docker.networks.size, 0, 'host-only graphs do not create a private network');
    assert.equal(docker.created.length, 1);
    assert.equal(docker.created[0].networkMode, 'host');
    assert.deepEqual(docker.created[0].networkAliases, []);
    assert.deepEqual(docker.created[0].publishPorts, []);
    assert.equal(docker.created[0].privileged, true);
    assert.deepEqual(docker.created[0].devices, [
      {
        hostPath: '/dev/ttyUSB0',
        containerPath: '/dev/zigbee',
        permissions: 'rw',
      },
    ]);
    assert.deepEqual(docker.probes[0], {
      kind: 'http',
      containerPort: 8123,
      path: '/',
      hostNetwork: true,
    });
    assert.equal(result.primaryPort, 8123);
    assert.equal(state.activeEndpoints('family-id/home-assistant/http')[0]?.host, '127.0.0.1');
  });

  it('runs install, restart, backup, restore, upgrade, and uninstall against deterministic fake Docker', async () => {
    const docker = new FakeGraphDocker();
    const state = new MemoryGraphState();
    const executor = new ApplicationGraphExecutor({ docker, state });
    const graphContext = context(runtime(RECOVERY_CONTRACT_MANIFEST));
    const directory = mkdtempSync(join(tmpdir(), 'deploy-graph-recovery-'));
    try {
      await executor.converge(graphContext);
      const installedContainerCount = docker.created.length;
      await executor.stop(graphContext);
      await executor.converge(graphContext);
      assert.equal(
        docker.created.length,
        installedContainerCount,
        'restart reuses fixed-slot containers',
      );
      const artifact = await executor.createRecoveryPoint(graphContext, directory);
      assert.match(artifact.artifactDigest, /^sha256:[a-f0-9]{64}$/);
      assert.match(artifact.verification, /digest-and-tar-verified/);
      const recoveryManifest = JSON.parse(readFileSync(artifact.artifactReference, 'utf8')) as {
        resources: Array<{ resource: string; consistencyGroup: string }>;
      };
      assert.deepEqual(
        recoveryManifest.resources.map(({ resource, consistencyGroup }) => ({
          resource,
          consistencyGroup,
        })),
        [{ resource: 'database-data', consistencyGroup: 'database-state' }],
      );
      assert.ok(
        state
          .listInstances('family-id', 'coordinator')
          .every((instance) => docker.containers.get(instance.containerName)?.running),
        'backup restarts the graph before it reports a verified point',
      );

      await executor.restoreRecoveryPoint(graphContext, artifact);
      assert.equal(docker.restoredVolumes.length, 1);
      assert.match(docker.restoredVolumes[0].volume, /database-data/);
      assert.ok(
        state
          .listInstances('family-id', 'coordinator')
          .every((instance) => !docker.containers.get(instance.containerName)?.running),
        'restore leaves traffic stopped until the caller health-gates convergence',
      );
      await executor.converge(graphContext);

      await executor.createRecoveryPoint(graphContext, directory, { resume: false });
      assert.ok(
        state
          .listInstances('family-id', 'coordinator')
          .every((instance) => !docker.containers.get(instance.containerName)?.running),
        'a single-writer handoff can keep the source quiesced after verified capture',
      );
      await executor.converge(graphContext);

      const upgradedContext = context(runtime(MANIFEST.replace('nginx:1.27', 'nginx:1.28')));
      await executor.converge(upgradedContext);
      assert.ok(
        docker.created.some(
          (request) =>
            request.labels['deploy-sh.component'] === 'web' && request.image === 'nginx:1.28',
        ),
        'upgrade creates the new web release after health admission',
      );

      await executor.remove({
        applicationId: graphContext.applicationId,
        siteId: graphContext.siteId,
        managedVolumeResources: ['database-data', 'web-cache'],
        removeInfrastructure: true,
      });
      assert.equal(docker.containers.size, 0);
      assert.equal(docker.volumes.size, 0);
      assert.equal(docker.networks.size, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('enforces an internal network and read-only roots for temporary validation graphs', async () => {
    const docker = new FakeGraphDocker();
    const state = new MemoryGraphState();
    const executor = new ApplicationGraphExecutor({ docker, state });
    const graphContext = {
      ...context(runtime(MANIFEST)),
      applicationId: 'validation-family',
      deploymentName: 'validation-family',
      validation: { denyExternalNetwork: true, enforceReadOnlyRoot: true },
    };

    await executor.converge(graphContext);

    assert.equal(docker.networkOptions.get('deploy-sh-validation-family-private')?.internal, true);
    for (const request of [...docker.created, ...docker.oneShots]) {
      assert.ok(request.runArgs?.includes('--read-only'));
      assert.ok(request.runArgs?.includes('/tmp:rw,noexec,nosuid,size=64m'));
    }
  });
});

function runtime(
  source: string,
  values: Record<string, string | number | boolean | null> = {},
  configurationDigest = 'sha256:configuration',
) {
  const compiled = compileDeployYaml(source);
  return buildApplicationGraphRuntime({
    applicationId: 'family-id',
    specDigest: compiled.digest,
    spec: compiled.spec,
    configuration: { digest: configurationDigest, values, missing: [] },
  });
}

function context(runtimeValue: ReturnType<typeof runtime>) {
  return {
    deploymentName: 'family',
    applicationId: 'family-id',
    siteId: 'coordinator',
    nodeId: 'coordinator',
    projectDirectory: '/tmp/family',
    runtime: runtimeValue,
    drainTimeoutMs: 0,
  };
}

function profileFixture() {
  const operationDirectory = mkdtempSync(join(tmpdir(), 'deploy-profile-operation-'));
  const docker = new FakeGraphDocker();
  const state = new MemoryGraphState();
  const artifacts = new FakeProfileArtifactStore();
  const executor = new ApplicationGraphExecutor({
    docker,
    state,
    artifacts,
    profileOperationsDirectory: operationDirectory,
  });
  return {
    docker,
    state,
    artifacts,
    executor,
    graphContext: context(runtime(MANIFEST)),
    cleanup: () => rmSync(operationDirectory, { recursive: true, force: true }),
  };
}

class FakeGraphDocker implements GraphDockerAdapter {
  readonly preparedImages: Array<Parameters<GraphDockerAdapter['prepareImage']>[0]> = [];
  readonly networks = new Set<string>();
  readonly networkOptions = new Map<string, { internal?: boolean }>();
  readonly volumes = new Set<string>();
  readonly containers = new Map<
    string,
    {
      request: GraphContainerCreateRequest;
      id: string;
      running: boolean;
      hostPorts: Record<number, number>;
    }
  >();
  readonly created: GraphContainerCreateRequest[] = [];
  readonly oneShots: GraphContainerCreateRequest[] = [];
  readonly probes: GraphHealthProbe[] = [];
  readonly execCommands: Array<{ name: string; command: readonly string[] }> = [];
  readonly copiedToContainers: Array<{
    name: string;
    hostPath: string;
    containerPath: string;
  }> = [];
  readonly restoredVolumes: Array<{ volume: string; archivePath: string }> = [];
  failNextHealthForComponent: string | null = null;
  failHealthForComponent: string | null = null;
  failDump = false;
  failRestore = false;
  #port = 41_000;

  async prepareImage(input: Parameters<GraphDockerAdapter['prepareImage']>[0]): Promise<string> {
    this.preparedImages.push(input);
    return input.source.kind === 'image'
      ? input.source.reference
      : `local/${input.applicationId}/${input.component}:${input.releaseDigest.slice(-8)}`;
  }
  async ensureNetwork(
    name: string,
    _labels: Readonly<Record<string, string>>,
    options: { internal?: boolean } = {},
  ): Promise<void> {
    this.networks.add(name);
    this.networkOptions.set(name, options);
  }
  async ensureVolume(name: string): Promise<void> {
    this.volumes.add(name);
  }
  async volumeExists(name: string): Promise<boolean> {
    return this.volumes.has(name);
  }
  async removeNetwork(name: string): Promise<void> {
    this.networks.delete(name);
  }
  async removeVolume(name: string): Promise<void> {
    this.volumes.delete(name);
  }
  async createContainer(
    request: GraphContainerCreateRequest,
  ): Promise<{ id: string; name: string }> {
    const id = `container-${this.created.length + 1}`;
    const hostPorts = Object.fromEntries(request.publishPorts.map((port) => [port, this.#port++]));
    this.created.push(request);
    this.containers.set(request.name, { request, id, running: false, hostPorts });
    return { id, name: request.name };
  }
  async startContainer(name: string): Promise<void> {
    const container = this.containers.get(name);
    if (!container) throw new Error(`missing fake container ${name}`);
    container.running = true;
  }
  async inspectContainer(name: string): Promise<GraphContainerInspection> {
    const container = this.containers.get(name);
    return container
      ? {
          id: container.id,
          name,
          exists: true,
          running: container.running,
          status: container.running ? 'running' : 'exited',
          health: container.running ? 'healthy' : 'none',
          hostPorts: container.hostPorts,
        }
      : {
          id: '',
          name,
          exists: false,
          running: false,
          status: 'missing',
          health: 'none',
          hostPorts: {},
        };
  }
  async waitHealthy(name: string, probe: GraphHealthProbe, _timeoutMs: number): Promise<boolean> {
    this.probes.push(probe);
    const container = this.containers.get(name);
    if (!container?.running) return false;
    if (
      this.failHealthForComponent &&
      container.request.labels['deploy-sh.component'] === this.failHealthForComponent
    ) {
      return false;
    }
    if (
      this.failNextHealthForComponent &&
      container.request.labels['deploy-sh.component'] === this.failNextHealthForComponent
    ) {
      this.failNextHealthForComponent = null;
      return false;
    }
    return true;
  }
  async stopContainer(name: string): Promise<void> {
    const container = this.containers.get(name);
    if (container) container.running = false;
  }
  async removeContainer(name: string): Promise<void> {
    this.containers.delete(name);
  }
  async runOneShot(request: GraphContainerCreateRequest): Promise<GraphCommandResult> {
    this.oneShots.push(request);
    return { exitCode: 0, output: 'ok' };
  }
  async exec(name: string, command: readonly string[]): Promise<GraphCommandResult> {
    this.execCommands.push({ name, command });
    const rendered = command.join(' ');
    if (this.failDump && rendered.includes('pg_dump')) {
      return { exitCode: 1, output: 'pg_dump failed' };
    }
    if (this.failRestore && rendered.includes('pg_restore')) {
      return { exitCode: 1, output: 'pg_restore failed' };
    }
    return { exitCode: 0, output: 'ok' };
  }
  async copyFromContainer(_name: string, _containerPath: string, hostPath: string): Promise<void> {
    mkdirSync(dirname(hostPath), { recursive: true });
    writeFileSync(hostPath, Buffer.from('deterministic postgresql custom archive'));
  }
  async copyToContainer(name: string, hostPath: string, containerPath: string): Promise<void> {
    this.copiedToContainers.push({ name, hostPath, containerPath });
  }
  async exportVolume(volume: string, archivePath: string) {
    const bytes = Buffer.from(`fake archive for ${volume}`);
    mkdirSync(dirname(archivePath), { recursive: true });
    writeFileSync(archivePath, bytes);
    return {
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const,
      bytes: bytes.length,
    };
  }
  async verifyVolumeArchive(archivePath: string): Promise<boolean> {
    return existsSync(archivePath);
  }
  async restoreVolume(volume: string, archivePath: string): Promise<void> {
    this.restoredVolumes.push({ volume, archivePath });
  }
}

class MemoryGraphState implements GraphRuntimeStateStore {
  readonly instances = new Map<string, ComponentInstanceRow>();
  readonly services = new Map<string, ComponentServiceRow>();
  readonly endpoints = new Map<string, { generation: number; values: ReadyEndpointInput[] }>();
  readonly jobs = new Map<string, ComponentJobExecutionRow>();
  readonly profileOperations = new Map<string, ComponentProfileOperationRow>();
  readonly profileVolumeBindings = new Map<string, ComponentProfileVolumeBindingRow>();
  readonly profileValues = new Map<string, string>();

  upsertPlacement(_input: Parameters<GraphRuntimeStateStore['upsertPlacement']>[0]): void {}
  listInstances(appId: string, siteId: string, componentKey?: string): ComponentInstanceRow[] {
    return [...this.instances.values()].filter(
      (row) =>
        row.appId === appId &&
        row.siteId === siteId &&
        (componentKey === undefined || row.componentKey === componentKey),
    );
  }
  putInstance(input: Parameters<GraphRuntimeStateStore['putInstance']>[0]): void {
    this.instances.set(input.id, input as ComponentInstanceRow);
  }
  patchInstance(id: string, patch: Parameters<GraphRuntimeStateStore['patchInstance']>[1]): void {
    Object.assign(this.instances.get(id)!, patch);
  }
  upsertService(input: Parameters<GraphRuntimeStateStore['upsertService']>[0]): void {
    const previous = this.services.get(input.id);
    this.services.set(input.id, {
      membershipGeneration: previous?.membershipGeneration ?? 0,
      ...input,
    } as ComponentServiceRow);
  }
  replaceReadyEndpoints(
    _deploymentName: string,
    serviceId: string,
    endpoints: readonly ReadyEndpointInput[],
    _drainDeadline: number,
  ): number {
    const generation = (this.endpoints.get(serviceId)?.generation ?? 0) + 1;
    this.endpoints.set(serviceId, { generation, values: [...endpoints] });
    const service = this.services.get(serviceId);
    if (service) service.membershipGeneration = generation;
    return generation;
  }
  activeEndpoints(serviceId: string): ReadyEndpointInput[] {
    return this.endpoints.get(serviceId)?.values ?? [];
  }
  getJobRecords(appId: string, siteId: string): ComponentJobExecutionRow[] {
    return [...this.jobs.values()].filter((row) => row.appId === appId && row.siteId === siteId);
  }
  startJob(input: Parameters<GraphRuntimeStateStore['startJob']>[0]): void {
    this.jobs.set(input.idempotencyKey, input as ComponentJobExecutionRow);
  }
  finishJob(key: string, status: 'succeeded' | 'failed', exitCode: number, output: string): void {
    Object.assign(this.jobs.get(key)!, { status, exitCode, output, completedAt: Date.now() });
  }
  replaceVolumeAttachments(
    _instanceId: string,
    _attachments: Parameters<GraphRuntimeStateStore['replaceVolumeAttachments']>[1],
  ): void {}
  startProfileOperation(
    input: Parameters<GraphRuntimeStateStore['startProfileOperation']>[0],
  ): void {
    const running = [...this.profileOperations.values()].find(
      (operation) =>
        operation.appId === input.appId &&
        operation.siteId === input.siteId &&
        operation.componentKey === input.componentKey &&
        operation.status === 'running',
    );
    if (running) throw new Error(`Profile operation ${running.id} is already running`);
    this.profileOperations.set(input.id, input as ComponentProfileOperationRow);
  }
  finishProfileOperation(
    id: string,
    status: 'succeeded' | 'failed',
    exitCode: number,
    output: string,
    verification?: string,
  ): void {
    Object.assign(this.profileOperations.get(id)!, {
      status,
      exitCode,
      output,
      verification,
      completedAt: Date.now(),
    });
  }
  patchProfileOperation(
    id: string,
    patch: Parameters<GraphRuntimeStateStore['patchProfileOperation']>[1],
  ): void {
    Object.assign(this.profileOperations.get(id)!, patch);
  }
  findProfileArtifactOperation(
    input: Parameters<GraphRuntimeStateStore['findProfileArtifactOperation']>[0],
  ): ComponentProfileOperationRow | undefined {
    return [...this.profileOperations.values()]
      .filter(
        (operation) =>
          operation.appId === input.appId &&
          operation.siteId === input.siteId &&
          operation.componentKey === input.componentKey &&
          operation.artifactDigest === input.artifactDigest,
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  }
  getProfileVolumeBinding(
    input: Parameters<GraphRuntimeStateStore['getProfileVolumeBinding']>[0],
  ): ComponentProfileVolumeBindingRow | undefined {
    return this.profileVolumeBindings.get(profileBindingKey(input));
  }
  listProfileVolumeBindings(appId: string, siteId: string): ComponentProfileVolumeBindingRow[] {
    return [...this.profileVolumeBindings.values()].filter(
      (binding) => binding.appId === appId && binding.siteId === siteId,
    );
  }
  commitProfileVolumeBinding(
    input: Parameters<GraphRuntimeStateStore['commitProfileVolumeBinding']>[0],
  ): void {
    this.profileVolumeBindings.set(
      profileBindingKey(input),
      input as ComponentProfileVolumeBindingRow,
    );
  }
  restoreProfileVolumeBinding(
    input: Parameters<GraphRuntimeStateStore['restoreProfileVolumeBinding']>[0],
    previous: Parameters<GraphRuntimeStateStore['restoreProfileVolumeBinding']>[1],
  ): void {
    const key = profileBindingKey(input);
    if (previous) this.profileVolumeBindings.set(key, previous);
    else this.profileVolumeBindings.delete(key);
  }
  getOrCreateProfileValue(
    input: Parameters<GraphRuntimeStateStore['getOrCreateProfileValue']>[0],
  ): string {
    const key = `${input.appId}/${input.siteId}/${input.componentKey}/${input.key}`;
    const value = this.profileValues.get(key) ?? input.create();
    this.profileValues.set(key, value);
    return value;
  }
}

class FakeProfileArtifactStore implements ProfileArtifactStore {
  readonly records = new Map<
    string,
    { localPath: string; mediaType: string; type: string; bytes: Buffer }
  >();

  async putFile(
    path: string,
    metadata: { type: string; mediaType: string; retentionClass: 'recovery' },
  ) {
    const bytes = readFileSync(path);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const localPath = `${path}.immutable`;
    writeFileSync(localPath, bytes);
    this.records.set(digest, {
      localPath,
      mediaType: metadata.mediaType,
      type: metadata.type,
      bytes,
    });
    return { digest, path: localPath, byteSize: bytes.length };
  }

  get(digest: string) {
    const record = this.records.get(digest);
    return record
      ? { localPath: record.localPath, mediaType: record.mediaType, type: record.type }
      : null;
  }

  async verify(digest: string): Promise<boolean> {
    const record = this.records.get(digest);
    if (!record || !existsSync(record.localPath)) return false;
    return (
      `sha256:${createHash('sha256').update(readFileSync(record.localPath)).digest('hex')}` ===
      digest
    );
  }

  corrupt(digest: string): void {
    const record = this.records.get(digest);
    if (record) writeFileSync(record.localPath, Buffer.from('corrupt'));
  }
}

function profileBindingKey(input: {
  appId: string;
  siteId: string;
  componentKey: string;
  resourceKey: string;
}): string {
  return `${input.appId}/${input.siteId}/${input.componentKey}/${input.resourceKey}`;
}
