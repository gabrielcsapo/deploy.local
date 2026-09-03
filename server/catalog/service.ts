import { randomUUID } from 'node:crypto';
import { emptyApplicationSpec, planApplicationChange } from '../application-plan.ts';
import { compileApplicationManifest } from '../application-spec.ts';
import { importDockerCompose } from './compose-import.ts';
import {
  planCatalogDerive,
  planCatalogDetach,
  planCatalogInstall,
  planCatalogUpgrade,
} from './planner.ts';
import { preflightCatalogInstall } from './preflight.ts';
import { CatalogStoreConflictError, type CatalogTransactionalStore } from './store.ts';
import type {
  CatalogInstallation,
  CatalogOperation,
  CatalogOperationPlan,
  CatalogRecoveryPoint,
  CatalogTargetProfile,
  ValidatedCatalogRelease,
} from './types.ts';

export interface CatalogRuntimeRequest {
  operation: CatalogOperation;
  installation: CatalogInstallation;
  answers?: Record<string, unknown>;
  recoveryPoint?: CatalogRecoveryPoint;
}

export interface CatalogRuntimeResult {
  /** accepted means durable desired state exists but the physical graph has not reported healthy. */
  state: 'accepted' | 'healthy';
}

export interface CatalogRuntimeCompletion {
  state: 'pending' | 'healthy' | 'failed';
  error?: string;
}

export type CatalogRecoveryArtifactResult =
  | { state: 'pending' }
  | {
      state?: 'verified';
      artifactReference: string;
      artifactDigest: `sha256:${string}`;
      verification: string;
    };

export type CatalogRecoveryCompletion =
  | { state: 'pending' }
  | { state: 'failed'; error: string }
  | {
      state: 'verified';
      artifactReference: string;
      artifactDigest: `sha256:${string}`;
      verification: string;
    };

export interface CatalogRecoveryRuntimeRequest {
  installation: CatalogInstallation;
  recoveryPoint: CatalogRecoveryPoint;
}

export interface CatalogRuntimeAdapter {
  execute(request: CatalogRuntimeRequest): Promise<CatalogRuntimeResult>;
  completion?(request: CatalogRuntimeRequest): Promise<CatalogRuntimeCompletion>;
  recoveryCompletion?(request: CatalogRecoveryRuntimeRequest): Promise<CatalogRecoveryCompletion>;
  createRecoveryPoint?(
    request: CatalogRecoveryRuntimeRequest,
  ): Promise<CatalogRecoveryArtifactResult>;
}

export interface CatalogBrowseItem {
  id: string;
  release: string;
  name: string;
  summary: string;
  categories: string[];
  publisher: string;
  trustTier: string;
  stage: string;
  contentDigest: string;
  promises: ValidatedCatalogRelease['release']['compatibility']['promises'];
  componentCount: number;
  resourceCount: number;
  securityGrantCount: number;
  /** Exact predecessor releases accepted by this signed release. */
  upgradeFrom: string[];
}

export class CatalogService {
  readonly #releases: ValidatedCatalogRelease[];
  readonly #store: CatalogTransactionalStore;

  constructor(releases: ValidatedCatalogRelease[], store: CatalogTransactionalStore) {
    this.#releases = [...releases];
    this.#store = store;
  }

  browse(query = ''): CatalogBrowseItem[] {
    const needle = query.trim().toLowerCase();
    return this.#releases
      .filter((item) => {
        if (!needle) return true;
        const haystack = [
          item.release.id,
          item.release.metadata.name,
          item.release.metadata.summary,
          ...item.release.metadata.categories,
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(needle);
      })
      .map((item) => ({
        id: item.release.id,
        release: item.release.release,
        name: item.release.metadata.name,
        summary: item.release.metadata.summary,
        categories: item.release.metadata.categories,
        publisher: item.release.publisher.name,
        trustTier: item.release.publisher.trustTier,
        stage: item.release.support.stage,
        contentDigest: item.release.contentDigest,
        promises: item.release.compatibility.promises,
        componentCount: Object.keys(item.normalizedSpec.components).length,
        resourceCount: Object.keys(item.normalizedSpec.resources).length,
        securityGrantCount: item.release.security.length,
        upgradeFrom: item.release.upgrades.map((upgrade) => upgrade.fromRelease),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  detail(id: string, release: string): ValidatedCatalogRelease {
    const match = this.#releases.find(
      (candidate) => candidate.release.id === id && candidate.release.release === release,
    );
    if (!match) throw new CatalogNotFoundError(`Catalog release ${id}@${release} was not found`);
    return match;
  }

  preflight(input: {
    id: string;
    release: string;
    applicationName: string;
    target: CatalogTargetProfile;
    answers?: Record<string, unknown>;
  }) {
    return preflightCatalogInstall({
      release: this.detail(input.id, input.release),
      applicationName: input.applicationName,
      target: input.target,
      answers: input.answers,
    });
  }

  installPlan(input: {
    id: string;
    release: string;
    applicationName: string;
    target: CatalogTargetProfile;
    answers?: Record<string, unknown>;
  }) {
    return planCatalogInstall({
      release: this.detail(input.id, input.release),
      applicationName: input.applicationName,
      target: input.target,
      answers: input.answers,
    });
  }

  upgradePlan(input: {
    installationId: string;
    toRelease: string;
    target: CatalogTargetProfile;
    answers?: Record<string, unknown>;
  }) {
    const installation = this.installation(input.installationId);
    return planCatalogUpgrade({
      installation,
      current: this.detail(installation.blueprintId, installation.release),
      target: this.detail(installation.blueprintId, input.toRelease),
      preflight: { target: input.target, answers: input.answers },
    });
  }

  detachPlan(installationId: string) {
    const installation = this.installation(installationId);
    return planCatalogDetach({
      installation,
      current: this.detail(installation.blueprintId, installation.release),
    });
  }

  derivePlan(installationId: string, localBlueprintId: string) {
    const installation = this.installation(installationId);
    return planCatalogDerive({
      installation,
      current: this.detail(installation.blueprintId, installation.release),
      localBlueprintId,
    });
  }

  composeImport(source: string, applicationName?: string) {
    return importDockerCompose(source, applicationName);
  }

  installations(): CatalogInstallation[] {
    return this.#store.read((transaction) => transaction.listInstallations());
  }

  installation(id: string): CatalogInstallation {
    const installation = this.#store.read((transaction) => transaction.getInstallation(id));
    if (!installation) throw new CatalogNotFoundError(`Catalog installation ${id} was not found`);
    return installation;
  }

  operations(installationId: string): CatalogOperation[] {
    this.installation(installationId);
    return this.#store.read((transaction) => transaction.listOperations(installationId));
  }

  recoveryPoints(installationId: string): CatalogRecoveryPoint[] {
    this.installation(installationId);
    return this.#store.read((transaction) => transaction.listRecoveryPoints(installationId));
  }

  /** Close durable remote work only after an authenticated target reports terminal state. */
  async reconcileRuntime(runtime: CatalogRuntimeAdapter): Promise<number> {
    let completed = 0;
    const installations = this.installations();
    if (runtime.completion) {
      const running = installations.flatMap((installation) =>
        this.operations(installation.id)
          .filter((operation) => operation.status === 'running')
          .map((operation) => ({ installation, operation })),
      );
      for (const item of running) {
        const result = await runtime.completion(item);
        if (result.state === 'pending') continue;
        this.#finish(
          item.installation.id,
          item.operation.id,
          result.state === 'healthy',
          result.state === 'failed'
            ? result.error || 'Remote catalog materialization failed'
            : undefined,
        );
        completed++;
      }
    }
    if (runtime.recoveryCompletion) {
      const pending = installations.flatMap((installation) =>
        this.recoveryPoints(installation.id)
          .filter((recoveryPoint) => recoveryPoint.status === 'pending')
          .map((recoveryPoint) => ({ installation, recoveryPoint })),
      );
      for (const item of pending) {
        const result = await runtime.recoveryCompletion({
          installation: item.installation,
          recoveryPoint: item.recoveryPoint,
        });
        if (result.state === 'pending') continue;
        if (result.state === 'failed') {
          this.#store.transaction((transaction) =>
            transaction.putRecoveryPoint({
              ...item.recoveryPoint,
              status: 'failed',
              verification: result.error,
            }),
          );
        } else {
          this.#store.transaction((transaction) =>
            transaction.putRecoveryPoint(
              verifiedRecoveryPoint(item.recoveryPoint, result, new Date().toISOString()),
            ),
          );
        }
        completed++;
      }
    }
    return completed;
  }

  recordRecoveryPoint(input: {
    installationId: string;
    actor: string;
    status: 'verified' | 'failed';
    artifactReference: string;
    artifactDigest: string;
    verification: string;
    now?: string;
  }): CatalogRecoveryPoint {
    if (!input.artifactReference || !input.artifactDigest.match(/^sha256:[a-f0-9]{64}$/)) {
      throw new Error('Recovery points require an artifact reference and sha256 digest');
    }
    if (!input.verification) throw new Error('Recovery points require verification evidence');
    const current = this.installation(input.installationId);
    const now = input.now ?? new Date().toISOString();
    const point: CatalogRecoveryPoint = {
      id: randomUUID(),
      installationId: current.id,
      applicationName: current.applicationName,
      siteId: current.siteId,
      release: current.release,
      specDigest: current.currentSpecDigest,
      status: input.status,
      artifactReference: input.artifactReference,
      artifactDigest: input.artifactDigest,
      verification: input.verification,
      createdBy: input.actor,
      createdAt: now,
      ...(input.status === 'verified' ? { verifiedAt: now } : {}),
    };
    return this.#store.transaction((transaction) => {
      transaction.putRecoveryPoint(point, true);
      return point;
    });
  }

  async createRecoveryPoint(input: {
    installationId: string;
    actor: string;
    runtime: CatalogRuntimeAdapter;
    now?: string;
  }): Promise<CatalogRecoveryPoint> {
    if (!input.runtime.createRecoveryPoint) {
      throw new Error('Catalog runtime does not support physical recovery points');
    }
    const current = this.installation(input.installationId);
    if (current.status !== 'healthy') {
      throw new Error('Recovery points can be created only for a healthy installation');
    }
    if (this.recoveryPoints(current.id).some((point) => point.status === 'pending')) {
      throw new Error('A recovery point is already pending for this installation');
    }
    const now = input.now ?? new Date().toISOString();
    const pending: CatalogRecoveryPoint = {
      id: randomUUID(),
      installationId: current.id,
      applicationName: current.applicationName,
      siteId: current.siteId,
      release: current.release,
      specDigest: current.currentSpecDigest,
      status: 'pending',
      createdBy: input.actor,
      createdAt: now,
    };
    this.#store.transaction((transaction) => transaction.putRecoveryPoint(pending, true));
    try {
      const artifact = await input.runtime.createRecoveryPoint({
        installation: current,
        recoveryPoint: pending,
      });
      if (artifact.state === 'pending') return pending;
      const verified = verifiedRecoveryPoint(pending, artifact, new Date().toISOString());
      return this.#store.transaction((transaction) => {
        transaction.putRecoveryPoint(verified);
        return verified;
      });
    } catch (error) {
      this.#store.transaction((transaction) =>
        transaction.putRecoveryPoint({
          ...pending,
          status: 'failed',
          verification: (error as Error).message,
        }),
      );
      throw error;
    }
  }

  async install(input: {
    plan: CatalogOperationPlan;
    applicationName: string;
    actor: string;
    runtime: CatalogRuntimeAdapter;
    answers?: Record<string, unknown>;
    now?: string;
  }): Promise<{ installation: CatalogInstallation; operation: CatalogOperation }> {
    if (input.plan.operation !== 'install' || !input.plan.ready) {
      throw new Error('Only a ready install plan can execute');
    }
    if (input.plan.normalizedSpec.metadata.name !== input.applicationName) {
      throw new Error('Install plan application name does not match the requested application');
    }
    const release = this.detail(input.plan.blueprintId, input.plan.toRelease);
    const compiled = compileApplicationManifest(input.plan.normalizedSpec);
    const now = input.now ?? new Date().toISOString();
    const installationId = randomUUID();
    const operation = operationRecord({
      installationId,
      applicationName: input.applicationName,
      operation: 'install',
      plan: input.plan,
      actor: input.actor,
      now,
    });
    const installation: CatalogInstallation = {
      id: installationId,
      applicationName: input.applicationName,
      blueprintId: release.release.id,
      release: release.release.release,
      blueprintDigest: release.release.contentDigest,
      installedSpecDigest: compiled.digest,
      currentSpecDigest: compiled.digest,
      siteId: input.plan.targetSiteId,
      mode: 'managed',
      status: 'installing',
      revision: 1,
      driftedAddresses: [],
      lastOperationId: operation.id,
      createdAt: now,
      updatedAt: now,
    };
    this.#store.transaction((transaction) => {
      if (transaction.getInstallationByApplication(input.applicationName)) {
        throw new CatalogStoreConflictError(
          `Catalog installation for ${input.applicationName} already exists`,
        );
      }
      transaction.putInstallation(installation, null);
      transaction.putOperation(operation, true);
    });
    return this.#execute({
      installation,
      operation,
      runtime: input.runtime,
      answers: this.#configurationAnswers(input.plan, input.answers),
    });
  }

  async upgrade(input: {
    plan: CatalogOperationPlan;
    expectedRevision: number;
    actor: string;
    runtime: CatalogRuntimeAdapter;
    answers?: Record<string, unknown>;
    recoveryPointId?: string;
    now?: string;
  }): Promise<{ installation: CatalogInstallation; operation: CatalogOperation }> {
    if (input.plan.operation !== 'upgrade' || !input.plan.ready || !input.plan.installationId) {
      throw new Error('Only a ready upgrade plan can execute');
    }
    const current = this.installation(input.plan.installationId);
    if (current.status !== 'healthy') throw new Error('Only a healthy installation can upgrade');
    const recoveryPoint = this.#requiredRecoveryPoint(
      current,
      input.recoveryPointId,
      input.plan.steps.some((step) => step.phase === 'recovery-point'),
    );
    const operation = operationRecord({
      installationId: current.id,
      applicationName: current.applicationName,
      operation: 'upgrade',
      plan: input.plan,
      actor: input.actor,
      recoveryPointId: recoveryPoint?.id,
      now: input.now,
    });
    const pending = this.#beginExistingOperation(
      current,
      input.expectedRevision,
      operation,
      'upgrading',
    );
    return this.#execute({
      installation: pending,
      operation,
      runtime: input.runtime,
      answers: this.#configurationAnswers(input.plan, input.answers),
      recoveryPoint,
    });
  }

  rollbackPlan(installationId: string, recoveryPointId: string): CatalogOperationPlan {
    const current = this.installation(installationId);
    const point = this.#requiredRecoveryPoint(current, recoveryPointId, true)!;
    const currentRelease = this.detail(current.blueprintId, current.release);
    const release = this.detail(current.blueprintId, point.release);
    const compiled = compileApplicationManifest({
      ...release.normalizedSpec,
      metadata: { ...release.normalizedSpec.metadata, name: current.applicationName },
    });
    if (compiled.digest !== point.specDigest) {
      throw new Error('Verified recovery point does not match its signed catalog release');
    }
    const currentSpec = compileApplicationManifest({
      ...currentRelease.normalizedSpec,
      metadata: { ...currentRelease.normalizedSpec.metadata, name: current.applicationName },
    }).spec;
    const changePlan = planApplicationChange(currentSpec, compiled.spec, {
      source: 'catalog',
      targetSiteId: current.siteId,
      verifiedBackup: true,
    });
    return {
      planId: randomUUID(),
      operation: 'rollback',
      installationId: current.id,
      blueprintId: current.blueprintId,
      fromRelease: current.release,
      toRelease: point.release,
      targetSiteId: current.siteId,
      ready: !changePlan.blocked,
      requiresApproval: true,
      destructive: true,
      blockers: changePlan.actions
        .filter((item) => item.blocked)
        .map((item) => ({
          id: `graph-plan:${item.address}`,
          dimension: 'release',
          severity: 'blocking',
          summary: item.reason,
        })),
      steps: [
        {
          id: 'verify-recovery-point',
          phase: 'recovery-point',
          summary: 'Revalidate the selected recovery artifact before mutation.',
          destructive: false,
          rollback: 'Abort without changing runtime state.',
        },
        {
          id: 'restore-runtime-and-data',
          phase: 'materialize',
          summary: 'Restore the pinned graph and data recorded by the recovery point.',
          destructive: true,
          rollback: 'Keep the failed release isolated and preserve diagnostic artifacts.',
        },
        {
          id: 'health-and-commit',
          phase: 'health',
          summary: 'Admit the restored graph only after health checks pass.',
          destructive: false,
          rollback: 'Keep traffic closed until an administrator retries or intervenes.',
        },
      ],
      changePlan,
      normalizedSpec: compiled.spec,
      note: 'Rollback requires a verified recovery point and remains health-gated.',
    };
  }

  async rollback(input: {
    plan: CatalogOperationPlan;
    recoveryPointId: string;
    expectedRevision: number;
    actor: string;
    runtime: CatalogRuntimeAdapter;
    now?: string;
  }): Promise<{ installation: CatalogInstallation; operation: CatalogOperation }> {
    if (input.plan.operation !== 'rollback' || !input.plan.installationId || !input.plan.ready) {
      throw new Error('Only a ready rollback plan can execute');
    }
    const current = this.installation(input.plan.installationId);
    const recoveryPoint = this.#requiredRecoveryPoint(current, input.recoveryPointId, true)!;
    const operation = operationRecord({
      installationId: current.id,
      applicationName: current.applicationName,
      operation: 'rollback',
      plan: input.plan,
      actor: input.actor,
      recoveryPointId: recoveryPoint.id,
      now: input.now,
    });
    const pending = this.#beginExistingOperation(
      current,
      input.expectedRevision,
      operation,
      'rolling-back',
    );
    return this.#execute({
      installation: pending,
      operation,
      runtime: input.runtime,
      recoveryPoint,
    });
  }

  uninstallPlan(installationId: string, retainData: boolean): CatalogOperationPlan {
    const current = this.installation(installationId);
    const release = this.detail(current.blueprintId, current.release);
    const currentSpec = compileApplicationManifest({
      ...release.normalizedSpec,
      metadata: { ...release.normalizedSpec.metadata, name: current.applicationName },
    }).spec;
    const desiredSpec = emptyApplicationSpec(current.applicationName);
    if (retainData) desiredSpec.resources = structuredClone(currentSpec.resources);
    const changePlan = planApplicationChange(currentSpec, desiredSpec, {
      source: 'catalog',
      targetSiteId: current.siteId,
      resourceRemovalPolicy: retainData ? 'retain' : 'delete',
    });
    const blockers =
      current.status === 'healthy' || current.status === 'failed'
        ? []
        : [
            {
              id: 'installation-operation-running',
              dimension: 'release' as const,
              severity: 'blocking' as const,
              summary: `Installation is ${current.status}; finish or fail that operation first.`,
            },
          ];
    blockers.push(
      ...changePlan.actions
        .filter((item) => item.blocked)
        .map((item) => ({
          id: `graph-plan:${item.address}`,
          dimension: 'release' as const,
          severity: 'blocking' as const,
          summary: item.reason,
        })),
    );
    return {
      planId: randomUUID(),
      operation: 'uninstall',
      installationId: current.id,
      blueprintId: current.blueprintId,
      fromRelease: current.release,
      toRelease: current.release,
      targetSiteId: current.siteId,
      ready: (current.status === 'healthy' || current.status === 'failed') && !changePlan.blocked,
      requiresApproval: true,
      destructive: !retainData || changePlan.destructive,
      blockers,
      steps: [
        {
          id: 'withdraw-runtime',
          phase: 'materialize',
          summary: 'Withdraw routes and remove catalog-managed runtime objects.',
          destructive: false,
          rollback: 'Re-materialize the current pinned graph.',
        },
        {
          id: retainData ? 'retain-data' : 'delete-data',
          phase: retainData ? 'commit' : 'recovery-point',
          summary: retainData
            ? 'Retain durable resources for explicit recovery or later cleanup.'
            : 'Verify a recovery point, then delete catalog-managed durable resources.',
          destructive: !retainData,
          rollback: retainData
            ? 'Data remains available.'
            : 'Restore only from the verified recovery artifact.',
        },
      ],
      changePlan,
      normalizedSpec: currentSpec,
      note: retainData
        ? 'Uninstall removes runtime state but intentionally retains durable application data.'
        : 'Delete-data uninstall is irreversible on the target and requires a verified recovery point.',
    };
  }

  async uninstall(input: {
    plan: CatalogOperationPlan;
    retainData: boolean;
    recoveryPointId?: string;
    expectedRevision: number;
    actor: string;
    runtime: CatalogRuntimeAdapter;
    now?: string;
  }): Promise<{ installation: CatalogInstallation; operation: CatalogOperation }> {
    if (input.plan.operation !== 'uninstall' || !input.plan.installationId || !input.plan.ready) {
      throw new Error('Only a ready uninstall plan can execute');
    }
    const current = this.installation(input.plan.installationId);
    const recoveryPoint = this.#requiredRecoveryPoint(
      current,
      input.recoveryPointId,
      !input.retainData,
    );
    const operation = operationRecord({
      installationId: current.id,
      applicationName: current.applicationName,
      operation: 'uninstall',
      plan: input.plan,
      actor: input.actor,
      retainData: input.retainData,
      recoveryPointId: recoveryPoint?.id,
      now: input.now,
    });
    const pending = this.#beginExistingOperation(
      current,
      input.expectedRevision,
      operation,
      'uninstalling',
    );
    return this.#execute({
      installation: pending,
      operation,
      runtime: input.runtime,
      recoveryPoint,
    });
  }

  async retry(input: {
    installationId: string;
    expectedRevision: number;
    actor: string;
    runtime: CatalogRuntimeAdapter;
    answers?: Record<string, unknown>;
    now?: string;
  }): Promise<{ installation: CatalogInstallation; operation: CatalogOperation }> {
    const current = this.installation(input.installationId);
    if (current.status !== 'failed' || !current.lastOperationId) {
      throw new Error('Only a failed catalog operation can be retried');
    }
    const previous = this.#store.read((transaction) =>
      transaction.getOperation(current.lastOperationId!),
    );
    if (!previous || previous.status !== 'failed') {
      throw new Error('Failed operation intent is missing');
    }
    const recoveryPoint = previous.recoveryPointId
      ? this.#requiredRecoveryPoint(current, previous.recoveryPointId, true)
      : undefined;
    const now = input.now ?? new Date().toISOString();
    const operation: CatalogOperation = {
      ...previous,
      status: 'running',
      attempt: previous.attempt + 1,
      actor: input.actor,
      error: undefined,
      updatedAt: now,
      completedAt: undefined,
    };
    const status = pendingStatus(operation.operation);
    const pending = this.#store.transaction((transaction) => {
      const observed = transaction.getInstallation(current.id);
      if (!observed || observed.revision !== input.expectedRevision) {
        throw new CatalogStoreConflictError('Installation revision changed before retry');
      }
      const next: CatalogInstallation = {
        ...observed,
        status,
        failure: undefined,
        revision: observed.revision + 1,
        updatedAt: now,
      };
      transaction.putInstallation(next, input.expectedRevision);
      transaction.putOperation(operation);
      return next;
    });
    return this.#execute({
      installation: pending,
      operation,
      runtime: input.runtime,
      answers: this.#configurationAnswers(operation.plan, input.answers),
      recoveryPoint,
    });
  }

  #configurationAnswers(
    plan: CatalogOperationPlan,
    answers: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (!answers) return undefined;
    const release = this.detail(plan.blueprintId, plan.toRelease);
    return Object.fromEntries(
      release.release.questions
        .filter((question) => Object.hasOwn(answers, question.key))
        .map((question) => [question.configuration, answers[question.key]]),
    );
  }

  /**
   * Integration seam called only after the ordinary runtime transaction reports the graph healthy.
   * Planning never writes catalog state.
   */
  commitHealthyInstall(input: {
    plan: CatalogOperationPlan;
    applicationName: string;
    runtimeHealthy: true;
    now?: string;
  }): CatalogInstallation {
    if (input.runtimeHealthy !== true) {
      throw new Error('Catalog state cannot commit before runtime health admission');
    }
    if (input.plan.operation !== 'install' || !input.plan.ready) {
      throw new Error('Only a ready install plan can be committed');
    }
    if (input.plan.normalizedSpec.metadata.name !== input.applicationName) {
      throw new Error('Install plan application name does not match the committed application');
    }
    const release = this.detail(input.plan.blueprintId, input.plan.toRelease);
    const compiled = compileApplicationManifest(input.plan.normalizedSpec);
    const now = input.now ?? new Date().toISOString();
    const installation: CatalogInstallation = {
      id: randomUUID(),
      applicationName: input.applicationName,
      blueprintId: release.release.id,
      release: release.release.release,
      blueprintDigest: release.release.contentDigest,
      installedSpecDigest: compiled.digest,
      currentSpecDigest: compiled.digest,
      siteId: input.plan.targetSiteId,
      mode: 'managed',
      status: 'healthy',
      revision: 1,
      driftedAddresses: [],
      createdAt: now,
      updatedAt: now,
    };
    return this.#store.transaction((transaction) => {
      transaction.putInstallation(installation, null);
      return installation;
    });
  }

  commitOwnershipPlan(input: {
    plan: CatalogOperationPlan;
    expectedRevision: number;
    localBlueprintId?: string;
    now?: string;
  }): CatalogInstallation {
    if (
      !input.plan.ready ||
      (input.plan.operation !== 'detach' && input.plan.operation !== 'derive')
    ) {
      throw new Error('Only a ready detach or derive plan can change catalog ownership');
    }
    if (input.plan.operation === 'derive' && !input.localBlueprintId) {
      throw new Error('A derived installation requires a local blueprint ID');
    }
    if (
      input.plan.operation === 'derive' &&
      input.plan.localBlueprintId !== input.localBlueprintId
    ) {
      throw new Error('Derived blueprint ID does not match the approved plan');
    }
    return this.#store.transaction((transaction) => {
      const current = transaction.getInstallation(input.plan.installationId || '');
      if (!current) throw new CatalogNotFoundError('Catalog installation was not found');
      const next: CatalogInstallation = {
        ...current,
        mode: input.plan.operation === 'derive' ? 'derived' : 'detached',
        ...(input.plan.operation === 'derive' ? { localBlueprintId: input.localBlueprintId } : {}),
        revision: current.revision + 1,
        updatedAt: input.now ?? new Date().toISOString(),
      };
      transaction.putInstallation(next, input.expectedRevision);
      return next;
    });
  }

  #requiredRecoveryPoint(
    installation: CatalogInstallation,
    recoveryPointId: string | undefined,
    required: boolean,
  ): CatalogRecoveryPoint | undefined {
    if (!recoveryPointId) {
      if (required) throw new Error('A verified recovery point is required before this operation');
      return undefined;
    }
    const point = this.#store.read((transaction) => transaction.getRecoveryPoint(recoveryPointId));
    if (!point || point.installationId !== installation.id || point.status !== 'verified') {
      throw new Error('Recovery point is missing, unverified, or belongs to another installation');
    }
    return point;
  }

  #beginExistingOperation(
    current: CatalogInstallation,
    expectedRevision: number,
    operation: CatalogOperation,
    status: CatalogInstallation['status'],
  ): CatalogInstallation {
    return this.#store.transaction((transaction) => {
      const observed = transaction.getInstallation(current.id);
      if (!observed || observed.revision !== expectedRevision) {
        throw new CatalogStoreConflictError('Installation revision changed before operation');
      }
      const pending: CatalogInstallation = {
        ...observed,
        status,
        failure: undefined,
        lastOperationId: operation.id,
        revision: observed.revision + 1,
        updatedAt: operation.updatedAt,
      };
      transaction.putInstallation(pending, expectedRevision);
      transaction.putOperation(operation, true);
      return pending;
    });
  }

  async #execute(input: {
    installation: CatalogInstallation;
    operation: CatalogOperation;
    runtime: CatalogRuntimeAdapter;
    answers?: Record<string, unknown>;
    recoveryPoint?: CatalogRecoveryPoint;
  }): Promise<{ installation: CatalogInstallation; operation: CatalogOperation }> {
    try {
      const result = await input.runtime.execute(input);
      if (result.state === 'accepted') {
        return { installation: input.installation, operation: input.operation };
      }
      return this.#finish(input.installation.id, input.operation.id, true);
    } catch (error) {
      this.#finish(input.installation.id, input.operation.id, false, (error as Error).message);
      throw error;
    }
  }

  #finish(
    installationId: string,
    operationId: string,
    success: boolean,
    failure?: string,
  ): { installation: CatalogInstallation; operation: CatalogOperation } {
    return this.#store.transaction((transaction) => {
      const installation = transaction.getInstallation(installationId);
      const operation = transaction.getOperation(operationId);
      if (!installation || !operation || installation.lastOperationId !== operationId) {
        throw new CatalogStoreConflictError('Catalog operation is no longer current');
      }
      const now = new Date().toISOString();
      const finishedOperation: CatalogOperation = {
        ...operation,
        status: success ? 'succeeded' : 'failed',
        ...(failure ? { error: failure } : {}),
        updatedAt: now,
        completedAt: now,
      };
      const target = this.detail(operation.plan.blueprintId, operation.plan.toRelease);
      const targetDigest = compileApplicationManifest(operation.plan.normalizedSpec).digest;
      const finishedInstallation: CatalogInstallation = {
        ...installation,
        status: success
          ? operation.operation === 'uninstall'
            ? 'uninstalled'
            : 'healthy'
          : 'failed',
        ...(success && (operation.operation === 'upgrade' || operation.operation === 'rollback')
          ? {
              release: target.release.release,
              blueprintDigest: target.release.contentDigest,
              currentSpecDigest: targetDigest,
              installedSpecDigest: targetDigest,
            }
          : {}),
        ...(success && operation.operation === 'uninstall'
          ? { dataRetained: operation.retainData === true }
          : {}),
        ...(failure ? { failure } : { failure: undefined }),
        revision: installation.revision + 1,
        updatedAt: now,
      };
      transaction.putOperation(finishedOperation);
      transaction.putInstallation(finishedInstallation, installation.revision);
      return { installation: finishedInstallation, operation: finishedOperation };
    });
  }
}

function operationRecord(input: {
  installationId: string;
  applicationName: string;
  operation: CatalogOperation['operation'];
  plan: CatalogOperationPlan;
  actor: string;
  retainData?: boolean;
  recoveryPointId?: string;
  now?: string;
}): CatalogOperation {
  const now = input.now ?? new Date().toISOString();
  return {
    id: randomUUID(),
    installationId: input.installationId,
    applicationName: input.applicationName,
    operation: input.operation,
    status: 'running',
    plan: input.plan,
    attempt: 1,
    actor: input.actor,
    ...(input.retainData !== undefined ? { retainData: input.retainData } : {}),
    ...(input.recoveryPointId ? { recoveryPointId: input.recoveryPointId } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function pendingStatus(operation: CatalogOperation['operation']): CatalogInstallation['status'] {
  if (operation === 'upgrade') return 'upgrading';
  if (operation === 'rollback') return 'rolling-back';
  if (operation === 'uninstall') return 'uninstalling';
  return 'installing';
}

function verifiedRecoveryPoint(
  pending: CatalogRecoveryPoint,
  artifact: Exclude<CatalogRecoveryArtifactResult, { state: 'pending' }>,
  verifiedAt: string,
): CatalogRecoveryPoint {
  if (
    !artifact.artifactReference ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.artifactDigest) ||
    !artifact.verification
  ) {
    throw new Error('Runtime returned invalid recovery artifact verification');
  }
  return {
    ...pending,
    artifactReference: artifact.artifactReference,
    artifactDigest: artifact.artifactDigest,
    verification: artifact.verification,
    status: 'verified',
    verifiedAt,
  };
}

export class CatalogNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogNotFoundError';
  }
}
