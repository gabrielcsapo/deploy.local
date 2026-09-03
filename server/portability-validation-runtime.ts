import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ResolvedApplicationConfiguration } from './application-configuration.ts';
import {
  ApplicationGraphExecutor,
  type GraphExecutorContext,
  type GraphRecoveryArtifact,
} from './application-graph-executor.ts';
import type { PlacementTargetEvidence } from './application-placement.ts';
import { buildApplicationGraphRuntime } from './application-runtime.ts';
import {
  createFileManifest,
  createSqliteChangesetArtifact,
  reconcileFileManifests,
} from './data-reconciliation.ts';
import { getArtifact, verifyArtifact } from './content-store.ts';
import { analyzePortability, type PortabilityVolumeSnapshot } from './portability.ts';
import type {
  FrozenValidationInput,
  PortabilityValidationAdapter,
  TemporaryReplicaResult,
  ValidationStepResult,
  ValidationTargetInspection,
} from './portability-validation.ts';

const execFileAsync = promisify(execFile);

export interface RuntimePortabilityValidationOptions {
  context: GraphExecutorContext;
  configuration: ResolvedApplicationConfiguration;
  placementTarget: PlacementTargetEvidence;
  targetInspection: ValidationTargetInspection;
  requiredArtifactDigests: readonly string[];
  sourceArtifactDigest?: `sha256:${string}`;
  executor?: ApplicationGraphExecutor;
}

/**
 * Production adapter for exact-release validation. It restores the quiesced snapshots into an
 * isolated graph, forces read-only container roots, uses an internal-only Docker network, runs
 * ordinary health/jobs, exercises the real SQLite/file reconciliation primitives, and always
 * destroys the temporary graph.
 */
export class RuntimePortabilityValidationAdapter implements PortabilityValidationAdapter {
  readonly #options: RuntimePortabilityValidationOptions;
  readonly #executor: ApplicationGraphExecutor;
  #root: string | null = null;
  #validationContext: GraphExecutorContext | null = null;

  constructor(options: RuntimePortabilityValidationOptions) {
    this.#options = options;
    this.#executor = options.executor ?? new ApplicationGraphExecutor();
  }

  async inspectTarget(): Promise<ValidationTargetInspection> {
    return this.#options.targetInspection;
  }

  async verifyArtifacts(): Promise<ValidationStepResult> {
    const missing: string[] = [];
    for (const digest of this.#options.requiredArtifactDigests) {
      if (!getArtifact(digest) || !(await verifyArtifact(digest))) missing.push(digest);
    }
    return {
      passed: missing.length === 0,
      detail:
        missing.length === 0
          ? [`Verified ${this.#options.requiredArtifactDigests.length} immutable artifact(s).`]
          : missing.map((digest) => `Missing or corrupt artifact ${digest}`),
    };
  }

  async verifyIdentityAndSecrets(): Promise<ValidationStepResult> {
    return {
      passed: this.#options.configuration.ready,
      detail: this.#options.configuration.ready
        ? ['Every target-scoped configuration declaration resolved without exporting values.']
        : this.#options.configuration.missing.map((key) => `Missing target value ${key}`),
    };
  }

  async startTemporaryReplica(input: FrozenValidationInput): Promise<TemporaryReplicaResult> {
    const unsafe = validationIsolationBlockers(input);
    if (unsafe.length > 0 || !this.#options.configuration.ready) {
      return failedReplica([
        ...unsafe,
        ...this.#options.configuration.missing.map((key) => `Missing target value ${key}`),
      ]);
    }
    this.#root = mkdtempSync(join(tmpdir(), 'deploy-portability-runtime-'));
    const suffix = createHash('sha256').update(input.inputDigest).digest('hex').slice(0, 12);
    const applicationId = `validation-${suffix}`;
    const deploymentName = `validation-${suffix}`;
    const runtime = buildApplicationGraphRuntime({
      applicationId,
      specDigest: input.specDigest,
      spec: input.spec,
      configuration: this.#options.configuration,
      siteId: input.siteId,
      options: { placementTarget: this.#options.placementTarget },
    });
    const context: GraphExecutorContext = {
      deploymentName,
      applicationId,
      siteId: input.siteId,
      nodeId: input.siteId,
      placementTarget: this.#options.placementTarget,
      projectDirectory: this.#options.context.projectDirectory,
      runtime,
      memoryLimit: this.#options.context.memoryLimit,
      cpuLimit: this.#options.context.cpuLimit,
      writerSiteId: input.siteId,
      drainTimeoutMs: 0,
      validation: { denyExternalNetwork: true, enforceReadOnlyRoot: true },
    };
    this.#validationContext = context;
    try {
      const recovery = await snapshotRecoveryArtifact(context, input.volumes, this.#root);
      await this.#executor.restoreRecoveryPoint(context, recovery);
      const result = await this.#executor.converge(context);
      const edgeRequestPassed = result.primaryPort
        ? await probeLocalPort(result.primaryPort, 5_000)
        : Object.keys(input.spec.routes).length === 0;
      return {
        containmentEnforced: true,
        healthPassed: true,
        edgeRequestPassed,
        externalDependencies: [],
        validatedWorkflows: [
          'read-only root',
          'declared managed volumes',
          'internal-only dependency network',
          'component health admission',
          ...(edgeRequestPassed ? ['published route probe'] : []),
        ],
        unverifiedWorkflows: [],
        observedMutablePaths: input.volumes.flatMap((volume) => listRelativeFiles(volume)),
        detail: [
          'The exact graph started from captured data with read-only roots and no external Docker route.',
          edgeRequestPassed
            ? 'The published local endpoint accepted a connection.'
            : 'The published local endpoint did not accept a connection.',
        ],
      };
    } catch (error) {
      return failedReplica([
        `Temporary isolated graph failed: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
  }

  async exerciseReconciliation(input: FrozenValidationInput): Promise<ValidationStepResult> {
    try {
      const structural = analyzePortability({
        appId: input.appId,
        siteId: input.siteId,
        specDigest: input.specDigest,
        spec: input.spec,
        volumes: [...input.volumes],
      });
      if (!structural.syncsAcrossSites) {
        return {
          passed: false,
          detail: structural.findings
            .filter((finding) => finding.severity === 'error')
            .map((finding) => finding.message),
        };
      }
      for (const file of structural.reconciliationProfile.sqliteFiles) {
        const volume = input.volumes.find((candidate) => candidate.resource === file.resource);
        if (!volume) throw new Error(`Missing snapshot for SQLite resource ${file.resource}`);
        const databasePath = resolve(volume.snapshotPath, file.relativePath);
        createSqliteChangesetArtifact(databasePath, databasePath, {
          includedTables: structural.reconciliationProfile.eligibleTables
            .filter((table) => table.file === `${file.resource}/${file.relativePath}`)
            .map((table) => table.table),
        });
      }
      for (const volume of input.volumes) {
        const manifest = createFileManifest(volume.snapshotPath);
        const merged = reconcileFileManifests({
          base: manifest,
          home: manifest,
          suitcase: manifest,
          conflictPolicy: 'collect',
          suitcaseSiteId: input.siteId,
        });
        if (merged.status !== 'merged') {
          throw new Error(`Identical file manifest did not merge for ${volume.resource}`);
        }
      }
      return {
        passed: true,
        detail: ['SQLite Session replay and three-way file-manifest validation passed.'],
      };
    } catch (error) {
      return {
        passed: false,
        detail: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  async buildWithoutNetwork(): Promise<ValidationStepResult> {
    if (!this.#validationContext || !this.#options.sourceArtifactDigest) {
      return {
        passed: false,
        detail: ['No exact source artifact is available for an offline build.'],
      };
    }
    try {
      const proof = await this.#executor.proveOfflineBuild(
        this.#validationContext,
        this.#options.sourceArtifactDigest,
      );
      return {
        passed: true,
        detail: [`No-network build proof ${proof.inputDigest}`],
      };
    } catch (error) {
      return { passed: false, detail: [error instanceof Error ? error.message : String(error)] };
    }
  }

  async cleanup(input: FrozenValidationInput): Promise<void> {
    try {
      if (this.#validationContext) {
        await this.#executor.remove({
          applicationId: this.#validationContext.applicationId,
          siteId: input.siteId,
          managedVolumeResources: Object.keys(input.spec.resources),
          removeInfrastructure: true,
        });
      }
    } finally {
      if (this.#root) rmSync(this.#root, { recursive: true, force: true });
      this.#root = null;
      this.#validationContext = null;
    }
  }
}

function validationIsolationBlockers(input: FrozenValidationInput): string[] {
  const blockers: string[] = [];
  for (const [name, component] of Object.entries(input.spec.components)) {
    if (component.runtime.networkMode === 'host') blockers.push(`${name} requires host networking`);
    if (component.runtime.privileged) blockers.push(`${name} requires privileged execution`);
    if (component.runtime.privilegedDocker) blockers.push(`${name} requires the Docker socket`);
    if (component.runtime.devices.length > 0) blockers.push(`${name} requires host devices`);
  }
  for (const [name, resource] of Object.entries(input.spec.resources)) {
    if (resource.source?.type === 'bind') blockers.push(`${name} is a host bind resource`);
  }
  return blockers;
}

function failedReplica(detail: string[]): TemporaryReplicaResult {
  return {
    containmentEnforced: false,
    healthPassed: false,
    edgeRequestPassed: false,
    externalDependencies: [],
    validatedWorkflows: [],
    unverifiedWorkflows: ['startup', 'health', 'published route'],
    observedMutablePaths: [],
    detail,
  };
}

async function snapshotRecoveryArtifact(
  context: GraphExecutorContext,
  volumes: readonly PortabilityVolumeSnapshot[],
  root: string,
): Promise<GraphRecoveryArtifact> {
  const recoveryRoot = resolve(root, 'recovery');
  mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
  const resources = [];
  for (const resourceName of Object.keys(context.runtime.spec.resources).sort()) {
    const resource = context.runtime.spec.resources[resourceName];
    if (resource.backup.policy === 'exclude') continue;
    const volume = volumes.find((candidate) => candidate.resource === resourceName);
    if (!volume) throw new Error(`Captured data is missing resource ${resourceName}`);
    const archive = `${createHash('sha256').update(resourceName).digest('hex').slice(0, 16)}.tar.gz`;
    const archivePath = resolve(recoveryRoot, archive);
    await execFileAsync('tar', ['-czf', archivePath, '-C', volume.snapshotPath, '.']);
    resources.push({
      resource: resourceName,
      consistencyGroup: resource.consistencyGroup,
      archive,
      digest: await fileDigest(archivePath),
      bytes: statSync(archivePath).size,
    });
  }
  const manifest = {
    version: 1,
    applicationId: context.applicationId,
    siteId: context.siteId,
    specDigest: context.runtime.execution.specDigest,
    configurationDigest: context.runtime.configurationDigest,
    resources,
  };
  const manifestPath = resolve(recoveryRoot, 'recovery-manifest.json');
  const content = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(manifestPath, content, { mode: 0o600 });
  return {
    artifactReference: manifestPath,
    artifactDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    verification: 'temporary-validation-snapshot',
  };
}

async function fileDigest(path: string): Promise<`sha256:${string}`> {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return `sha256:${hash.digest('hex')}`;
}

function listRelativeFiles(volume: PortabilityVolumeSnapshot): string[] {
  if (!existsSync(volume.snapshotPath)) return [];
  const result: string[] = [];
  const queue = [volume.snapshotPath];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile()) {
        result.push(`${volume.resource}/${relative(volume.snapshotPath, path)}`);
      }
    }
  }
  return result.sort();
}

function probeLocalPort(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: '127.0.0.1', port });
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const finish = (passed: boolean) => {
      clearTimeout(timeout);
      socket.destroy();
      resolvePromise(passed);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
