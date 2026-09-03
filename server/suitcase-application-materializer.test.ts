import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { GraphMaterializationResult } from './application-graph-executor.ts';
import type {
  GraphCommandResult,
  GraphContainerCreateRequest,
  GraphContainerInspection,
  GraphDockerAdapter,
  GraphHealthProbe,
} from './graph-docker-adapter.ts';

const FIRST = `
apiVersion: deploy.local/v1
kind: Application
metadata:
  name: notes
components:
  web:
    image: nginx:1.27
    role: web
    interfaces:
      http:
        port: 8080
        protocol: http
    health:
      interface: http
      path: /health
routes:
  public:
    to: web.http
`;

const SECOND = FIRST.replace('nginx:1.27', 'nginx:1.28');

const SITE_LOCAL_ONLY = `${FIRST}
resources:
  data:
    type: volume
    suitcase:
      allowedDataModes: [site-local]
`;

const BUILD = `
apiVersion: deploy.local/v1
kind: Application
metadata:
  name: notes
components:
  web:
    build:
      context: .
      dockerfile: Dockerfile
    role: web
    interfaces:
      http:
        port: 8080
        protocol: http
    health:
      interface: http
      path: /health
routes:
  public:
    to: web.http
`;

let root: string;
let store: typeof import('./store.ts');
let specs: typeof import('./application-spec.ts');
let executorModule: typeof import('./application-graph-executor.ts');
let projector: typeof import('./suitcase-projector.ts');
let materializer: typeof import('./suitcase-application-materializer.ts');
let multisite: typeof import('./multisite.ts');
let content: typeof import('./content-store.ts');
let docker: FakeDocker;
let graphExecutor: InstanceType<typeof executorModule.ApplicationGraphExecutor>;

const membership = {
  protocolVersion: 1 as const,
  fleetId: 'fleet-test',
  siteId: 'site-suitcase',
  homeSiteId: 'site-home',
  name: 'Travel',
  publicKey: 'suitcase-public',
  credential: 'suitcase-credential',
  homeUrl: 'https://home.invalid',
  siteKeys: { 'site-home': 'home-public', 'site-suitcase': 'suitcase-public' },
  defaultDataPolicy: 'none' as const,
  accessMode: 'existing-lan',
  securityProfile: 'isolated',
  mode: 'docked' as const,
  acknowledgedHomeSequence: 0,
  acknowledgedLocalSequence: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-suitcase-materializer-'));
  process.env.DEPLOY_DATA_DIR = root;
  store = await import(`./store.ts?materializer=${Date.now()}`);
  specs = await import(`./application-spec.ts?materializer=${Date.now()}`);
  executorModule = await import(`./application-graph-executor.ts?materializer=${Date.now()}`);
  projector = await import(`./suitcase-projector.ts?materializer=${Date.now()}`);
  materializer = await import(`./suitcase-application-materializer.ts?materializer=${Date.now()}`);
  multisite = await import(`./multisite.ts?materializer=${Date.now()}`);
  content = await import(`./content-store.ts?materializer=${Date.now()}`);
  docker = new FakeDocker();
  graphExecutor = new executorModule.ApplicationGraphExecutor({ docker });
  projector.bootstrapSuitcaseFleet({
    fleetId: membership.fleetId,
    homeSiteId: membership.homeSiteId,
    localSiteId: membership.siteId,
    localSiteName: membership.name,
    rootPublicIdentity: membership.siteKeys['site-home'],
    localPublicKey: membership.publicKey,
    siteKeys: membership.siteKeys,
    defaultDataPolicy: membership.defaultDataPolicy,
    accessMode: membership.accessMode,
    securityProfile: membership.securityProfile,
    siteCredential: membership.credential,
  });
  const now = new Date().toISOString();
  store
    .getSqlite()!
    .prepare('INSERT INTO users (username, password, role, created_at) VALUES (?, ?, ?, ?)')
    .run('admin', 'not-used', 'admin', now);
  installRevision(FIRST, null);
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('Suitcase target-local graph materialization', () => {
  it('converges a selected replica and records evidence before promoting active', async () => {
    const [result] = await materializer.reconcileSuitcaseApplications(membership, {
      executor: graphExecutor,
      accessProbe: async () => ({ ready: true, evidence: 'test listener' }),
      drainTimeoutMs: 0,
    });

    assert.equal(result?.status, 'ready');
    assert.equal(result?.activeSpecDigest, specs.compileDeployYaml(FIRST).digest);
    const deployment = store
      .getSqlite()!
      .prepare('SELECT active_spec_digest, status FROM deployments WHERE name = ?')
      .get('notes') as { active_spec_digest: string; status: string };
    assert.deepEqual(deployment, {
      active_spec_digest: specs.compileDeployYaml(FIRST).digest,
      status: 'running',
    });
    const evidence = store
      .getSqlite()!
      .prepare(
        `SELECT capability, state FROM app_materialization
          WHERE app_id = 'app-notes' AND site_id = 'site-suitcase'`,
      )
      .all() as Array<{ capability: string; state: string }>;
    assert.deepEqual(Object.fromEntries(evidence.map((row) => [row.capability, row.state])), {
      access: 'ready',
      data: 'ready',
      identity: 'ready',
      release: 'ready',
      rollback: 'unknown',
      runtime: 'ready',
    });
  });

  it('blocks a newly narrowed revision while the selected replica uses an incompatible topology', async () => {
    const firstDigest = specs.compileDeployYaml(FIRST).digest;
    const restrictedDigest = installRevision(SITE_LOCAL_ONLY, firstDigest);
    try {
      store
        .getSqlite()!
        .prepare(
          `UPDATE app_replicas
              SET data_mode = 'replicated', sync_policy = 'automatic', shared_lineage = 1
            WHERE app_id = 'app-notes' AND site_id = 'site-suitcase'`,
        )
        .run();

      const [result] = await materializer.reconcileSuitcaseApplications(membership, {
        executor: graphExecutor,
        accessProbe: async () => ({ ready: true, evidence: 'test listener' }),
        drainTimeoutMs: 0,
      });

      assert.equal(result?.status, 'blocked');
      assert.equal(result?.specDigest, restrictedDigest);
      assert.match(result?.blockers.join('; ') || '', /syncs-across-sites.*not allowed/);
      assert.equal(result?.activeSpecDigest, firstDigest);
    } finally {
      store
        .getSqlite()!
        .prepare(`UPDATE deployments SET desired_spec_digest = ? WHERE name = 'notes'`)
        .run(firstDigest);
      store
        .getSqlite()!
        .prepare(
          `UPDATE app_replicas
              SET data_mode = 'site-local', sync_policy = 'none', shared_lineage = 0
            WHERE app_id = 'app-notes' AND site_id = 'site-suitcase'`,
        )
        .run();
    }
  });

  it('keeps the prior healthy release active when desired health admission fails', async () => {
    const firstDigest = specs.compileDeployYaml(FIRST).digest;
    const secondDigest = installRevision(SECOND, firstDigest);
    // Re-admit the active release, then fail its replacement.
    store
      .getSqlite()!
      .prepare('UPDATE deployments SET desired_spec_digest = ? WHERE name = ?')
      .run(firstDigest, 'notes');
    await materializer.reconcileSuitcaseApplications(membership, {
      executor: graphExecutor,
      accessProbe: async () => ({ ready: true, evidence: 'test listener' }),
      drainTimeoutMs: 0,
    });
    store
      .getSqlite()!
      .prepare('UPDATE deployments SET desired_spec_digest = ? WHERE name = ?')
      .run(secondDigest, 'notes');
    docker.failNextHealth = true;

    const [result] = await materializer.reconcileSuitcaseApplications(membership, {
      executor: graphExecutor,
      accessProbe: async () => ({ ready: true, evidence: 'test listener' }),
      drainTimeoutMs: 0,
    });
    assert.equal(result?.status, 'failed');
    assert.equal(result?.activeSpecDigest, firstDigest);
    const deployment = store
      .getSqlite()!
      .prepare('SELECT active_spec_digest, status FROM deployments WHERE name = ?')
      .get('notes') as { active_spec_digest: string; status: string };
    assert.deepEqual(deployment, { active_spec_digest: firstDigest, status: 'running' });
    const runtime = store
      .getSqlite()!
      .prepare(
        `SELECT state, desired_digest, available_digest FROM app_materialization
          WHERE app_id = 'app-notes' AND site_id = 'site-suitcase' AND capability = 'runtime'`,
      )
      .get() as { state: string; desired_digest: string; available_digest: string };
    assert.deepEqual(runtime, {
      state: 'blocked',
      desired_digest: secondDigest,
      available_digest: firstDigest,
    });
  });

  it('reports catalog completion exactly once per operation attempt and removes locally', async () => {
    const digest = specs.compileDeployYaml(SECOND).digest;
    multisite.appendLocalFleetEvent({
      originSiteId: membership.homeSiteId,
      appId: 'app-notes',
      actor: 'admin',
      operation: 'application.revision.desired',
      payload: {
        name: 'notes',
        siteId: membership.siteId,
        specDigest: digest,
        catalogOperationId: 'catalog-operation-1',
        catalogOperationAttempt: 2,
      },
    });
    await materializer.reconcileSuitcaseApplications(membership, {
      executor: graphExecutor,
      accessProbe: async () => ({ ready: true, evidence: 'test listener' }),
      drainTimeoutMs: 0,
    });
    await materializer.reconcileSuitcaseApplications(membership, {
      executor: graphExecutor,
      accessProbe: async () => ({ ready: true, evidence: 'test listener' }),
      drainTimeoutMs: 0,
    });
    const completions = store
      .getSqlite()!
      .prepare(
        `SELECT payload FROM fleet_events
          WHERE origin_site_id = ? AND operation = 'catalog.operation.materialized'
            AND json_extract(payload, '$.catalogOperationId') = 'catalog-operation-1'`,
      )
      .all(membership.siteId) as Array<{ payload: string }>;
    assert.equal(completions.length, 1);
    assert.equal(JSON.parse(completions[0]!.payload).catalogOperationAttempt, 2);
    assert.equal(JSON.parse(completions[0]!.payload).status, 'ready');

    multisite.appendLocalFleetEvent({
      originSiteId: membership.homeSiteId,
      appId: 'app-notes',
      actor: 'admin',
      operation: 'catalog.recovery.requested',
      payload: {
        siteId: membership.siteId,
        recoveryPointId: 'recovery-before-upgrade',
      },
    });
    await materializer.reconcileSuitcaseApplications(membership, {
      executor: graphExecutor,
      accessProbe: async () => ({ ready: true, evidence: 'test listener' }),
      drainTimeoutMs: 0,
    });
    const recovery = store
      .getSqlite()!
      .prepare(
        `SELECT payload FROM fleet_events
          WHERE origin_site_id = ? AND operation = 'catalog.recovery.materialized'
            AND json_extract(payload, '$.recoveryPointId') = 'recovery-before-upgrade'`,
      )
      .get(membership.siteId) as { payload: string };
    assert.equal(JSON.parse(recovery.payload).status, 'verified');
    assert.match(JSON.parse(recovery.payload).artifactDigest, /^sha256:[a-f0-9]{64}$/);

    multisite.appendLocalFleetEvent({
      originSiteId: membership.homeSiteId,
      appId: 'app-notes',
      actor: 'admin',
      operation: 'application.replica.removed',
      payload: {
        siteId: membership.siteId,
        catalogOperationId: 'catalog-operation-remove',
        catalogOperationAttempt: 1,
        retainData: true,
        managedVolumeResources: [],
      },
    });
    await materializer.reconcileSuitcaseApplications(membership, {
      executor: graphExecutor,
      accessProbe: async () => ({ ready: true, evidence: 'test listener' }),
      drainTimeoutMs: 0,
    });
    const removal = store
      .getSqlite()!
      .prepare(
        `SELECT payload FROM fleet_events
          WHERE origin_site_id = ? AND operation = 'catalog.operation.materialized'
            AND json_extract(payload, '$.catalogOperationId') = 'catalog-operation-remove'`,
      )
      .get(membership.siteId) as { payload: string };
    assert.equal(JSON.parse(removal.payload).status, 'removed');
    const replica = store
      .getSqlite()!
      .prepare('SELECT runtime_status, removed_at FROM app_replicas WHERE id = ?')
      .get('replica-notes') as { runtime_status: string; removed_at: string };
    assert.equal(replica.runtime_status, 'removed');
    assert.ok(replica.removed_at);
  });

  it('restores a requested recovery point before converging rollback intent', async () => {
    const digest = specs.compileDeployYaml(SECOND).digest;
    store
      .getSqlite()!
      .prepare(
        `UPDATE app_replicas SET removed_at = NULL, runtime_status = 'pending', updated_at = ?
          WHERE id = 'replica-notes'`,
      )
      .run(new Date().toISOString());
    multisite.appendLocalFleetEvent({
      originSiteId: membership.homeSiteId,
      appId: 'app-notes',
      actor: 'admin',
      operation: 'application.revision.desired',
      payload: {
        name: 'notes',
        siteId: membership.siteId,
        specDigest: digest,
        catalogOperationId: 'catalog-operation-rollback',
        catalogOperationAttempt: 1,
        recoveryPointId: 'recovery-before-upgrade',
        recoveryArtifactReference: '/target/catalog-recovery/recovery-manifest.json',
        recoveryArtifactDigest: `sha256:${'a'.repeat(64)}`,
      },
    });
    const calls: string[] = [];
    const executor = {
      async restoreRecoveryPoint() {
        calls.push('restore');
      },
      async converge(): Promise<GraphMaterializationResult> {
        calls.push('converge');
        return {
          applicationId: 'app-notes',
          releaseDigest: digest,
          configurationDigest: 'sha256:configuration',
          network: 'fake',
          primaryPort: 44_000,
          primaryContainerId: 'rollback-container',
          primaryContainerName: 'notes-web-rollback',
          instances: [],
        };
      },
      async createRecoveryPoint() {
        throw new Error('not used');
      },
      async remove() {},
    };
    const [result] = await materializer.reconcileSuitcaseApplications(membership, {
      executor,
      accessProbe: async () => ({ ready: true, evidence: 'test listener' }),
      drainTimeoutMs: 0,
    });
    assert.equal(result?.status, 'ready');
    assert.deepEqual(calls, ['restore', 'converge']);
    const completion = store
      .getSqlite()!
      .prepare(
        `SELECT payload FROM fleet_events
          WHERE origin_site_id = ? AND operation = 'catalog.operation.materialized'
            AND json_extract(payload, '$.catalogOperationId') = 'catalog-operation-rollback'`,
      )
      .get(membership.siteId) as { payload: string };
    assert.equal(JSON.parse(completion.payload).status, 'ready');
  });

  it('never starts a Follows one site recovery-only replica', async () => {
    store
      .getSqlite()!
      .prepare(
        `UPDATE app_replicas SET data_mode = 'follows-one-site-recovery',
                runtime_status = 'recovery-only', updated_at = ?
          WHERE id = 'replica-notes'`,
      )
      .run(new Date().toISOString());
    let converged = false;
    const executor = {
      async converge() {
        converged = true;
        throw new Error('recovery-only replica must not converge');
      },
      async createRecoveryPoint() {
        throw new Error('not used');
      },
      async restoreRecoveryPoint() {
        throw new Error('not used');
      },
      async remove() {},
    };
    const [result] = await materializer.reconcileSuitcaseApplications(membership, {
      executor,
      accessProbe: async () => ({ ready: true, evidence: 'test listener' }),
    });
    assert.equal(converged, false);
    assert.equal(result?.status, 'blocked');
    assert.match(result?.blockers.join('; ') || '', /current writer site/);
    const replica = store
      .getSqlite()!
      .prepare('SELECT runtime_status FROM app_replicas WHERE id = ?')
      .get('replica-notes') as { runtime_status: string };
    assert.equal(replica.runtime_status, 'recovery-only');
  });

  it('marks Build Ready only from persisted proof for the exact no-network source build', async () => {
    store
      .getSqlite()!
      .prepare(
        `UPDATE app_replicas SET data_mode = 'site-local', runtime_status = 'pending',
                removed_at = NULL, updated_at = ? WHERE id = 'replica-notes'`,
      )
      .run(new Date().toISOString());
    const previous = specs.compileDeployYaml(SECOND).digest;
    const digest = installRevision(BUILD, previous);
    const source = join(root, 'offline-build-source');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'Dockerfile'), 'FROM scratch\nCOPY package-lock.json /\n');
    writeFileSync(join(source, 'package-lock.json'), '{"lockfileVersion":3}\n');
    const archive = join(root, 'offline-build-source.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', source, '.']);
    const artifact = await content.putArtifactFile(archive, {
      type: 'source',
      retentionClass: 'release',
    });
    store
      .getSqlite()!
      .prepare('UPDATE deployments SET source_artifact_digest = ? WHERE name = ?')
      .run(artifact.digest, 'notes');
    docker.preparedImages.length = 0;

    const [result] = await materializer.reconcileSuitcaseApplications(membership, {
      executor: graphExecutor,
      accessProbe: async () => ({ ready: true, evidence: 'test listener' }),
      drainTimeoutMs: 0,
    });

    assert.equal(result?.status, 'ready');
    assert.deepEqual(
      {
        forceBuild: docker.preparedImages[0]?.forceBuild,
        networkMode: docker.preparedImages[0]?.networkMode,
      },
      { forceBuild: true, networkMode: 'none' },
    );
    const build = store
      .getSqlite()!
      .prepare(
        `SELECT state, desired_digest, available_digest, evidence
           FROM app_materialization
          WHERE app_id = 'app-notes' AND site_id = 'site-suitcase' AND capability = 'build'`,
      )
      .get() as {
      state: string;
      desired_digest: string;
      available_digest: string;
      evidence: string;
    };
    assert.equal(build.state, 'ready');
    assert.equal(build.desired_digest, build.available_digest);
    assert.match(build.desired_digest, /^sha256:[a-f0-9]{64}$/);
    const evidence = JSON.parse(build.evidence) as Array<Record<string, unknown>>;
    assert.equal(evidence[0]?.source, 'target-no-network-build');
    assert.equal(evidence[0]?.sourceArtifactDigest, artifact.digest);
    assert.equal(evidence[0]?.specDigest, digest);
    assert.equal(evidence[0]?.networkMode, 'none');

    docker.failOfflineBuild = true;
    const [blocked] = await materializer.reconcileSuitcaseApplications(membership, {
      executor: graphExecutor,
      accessProbe: async () => ({ ready: true, evidence: 'test listener' }),
      drainTimeoutMs: 0,
    });
    assert.equal(blocked?.status, 'blocked');
    assert.deepEqual(
      store
        .getSqlite()!
        .prepare(
          `SELECT capability, state FROM app_materialization
            WHERE app_id = 'app-notes' AND site_id = 'site-suitcase'
              AND capability IN ('build', 'runtime') ORDER BY capability`,
        )
        .all(),
      [
        { capability: 'build', state: 'blocked' },
        { capability: 'runtime', state: 'ready' },
      ],
    );
  });
});

function installRevision(source: string, parentDigest: string | null): string {
  const compiled = specs.compileDeployYaml(source);
  const sqlite = store.getSqlite()!;
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO deployments
        (name, type, username, status, desired_node_id, desired_spec_digest,
         active_spec_digest, app_id, release_generation, created_at, updated_at)
       VALUES ('notes', 'application-graph', 'admin', 'stopped', 'site-suitcase', ?, NULL,
               'app-notes', 1, ?, ?)
       ON CONFLICT(name) DO UPDATE SET desired_spec_digest = excluded.desired_spec_digest,
         updated_at = excluded.updated_at`,
    )
    .run(compiled.digest, now, now);
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO application_spec_revisions
        (digest, deployment_name, parent_digest, api_version, source, manifest_format,
         normalized_spec, created_by, created_at)
       VALUES (?, 'notes', ?, 'deploy.local/v1', 'repository', 'deploy.yaml', ?, 'admin', ?)`,
    )
    .run(compiled.digest, parentDigest, compiled.canonicalJson, now);
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO app_replicas
        (id, app_id, site_id, desired_release_digest, runtime_status, data_mode,
         sync_policy, shared_lineage, readiness, created_at, updated_at)
       VALUES ('replica-notes', 'app-notes', 'site-suitcase', ?, 'pending', 'site-local',
               'none', 0, '{}', ?, ?)`,
    )
    .run(compiled.digest, now, now);
  return compiled.digest;
}

class FakeDocker implements GraphDockerAdapter {
  readonly preparedImages: Array<Parameters<GraphDockerAdapter['prepareImage']>[0]> = [];
  readonly containers = new Map<
    string,
    {
      request: GraphContainerCreateRequest;
      id: string;
      running: boolean;
      ports: Record<number, number>;
    }
  >();
  failNextHealth = false;
  failOfflineBuild = false;
  #port = 43_000;

  async prepareImage(input: Parameters<GraphDockerAdapter['prepareImage']>[0]) {
    this.preparedImages.push(input);
    if (input.networkMode === 'none' && this.failOfflineBuild) {
      this.failOfflineBuild = false;
      throw new Error('dependency cache is incomplete');
    }
    return input.source.kind === 'image' ? input.source.reference : 'fake-build';
  }
  async ensureNetwork() {}
  async ensureVolume() {}
  async volumeExists() {
    return true;
  }
  async removeNetwork() {}
  async removeVolume() {}
  async createContainer(request: GraphContainerCreateRequest) {
    const id = `container-${this.containers.size + 1}`;
    const ports = Object.fromEntries(request.publishPorts.map((port) => [port, this.#port++]));
    this.containers.set(request.name, { request, id, running: false, ports });
    return { id, name: request.name };
  }
  async startContainer(name: string) {
    const container = this.containers.get(name);
    if (!container) throw new Error(`missing ${name}`);
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
          hostPorts: container.ports,
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
  async waitHealthy(_name: string, _probe: GraphHealthProbe) {
    if (this.failNextHealth) {
      this.failNextHealth = false;
      return false;
    }
    return true;
  }
  async stopContainer(name: string) {
    const container = this.containers.get(name);
    if (container) container.running = false;
  }
  async removeContainer(name: string) {
    this.containers.delete(name);
  }
  async runOneShot(_request: GraphContainerCreateRequest): Promise<GraphCommandResult> {
    return { exitCode: 0, output: 'ok' };
  }
  async exec(): Promise<GraphCommandResult> {
    return { exitCode: 0, output: 'ok' };
  }
  async copyFromContainer(): Promise<void> {}
  async copyToContainer(): Promise<void> {}
  async exportVolume(volume: string, archivePath: string) {
    const bytes = Buffer.from(`fake ${volume}`);
    mkdirSync(dirname(archivePath), { recursive: true });
    writeFileSync(archivePath, bytes);
    return {
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const,
      bytes: bytes.length,
    };
  }
  async verifyVolumeArchive(path: string) {
    return existsSync(path);
  }
  async restoreVolume() {}
}
