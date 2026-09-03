import { createHash } from 'node:crypto';
import type { ApplicationSpec } from './application-spec.ts';
import {
  analyzePortability,
  persistPortabilityReport,
  type CapabilityDimension,
  type PortabilityAnalysisInput,
  type PortabilityEvidence,
  type PortabilityFinding,
  type PortabilityReport,
  type PortabilityVolumeSnapshot,
} from './portability.ts';

export interface ValidationTargetInspection {
  platform: string;
  architecture: string;
  compatibleArchitectures: string[];
  runtimeAvailable: boolean;
  requiredDevicesAvailable: boolean;
  detail: string[];
}

export interface TemporaryReplicaResult {
  containmentEnforced: boolean;
  healthPassed: boolean;
  edgeRequestPassed: boolean;
  /** Destinations reached while the adapter denied Home and internet access. */
  externalDependencies: Array<{
    destination: string;
    required: boolean;
    evidence: string;
  }>;
  validatedWorkflows: string[];
  unverifiedWorkflows: string[];
  observedMutablePaths: string[];
  detail: string[];
}

export interface ValidationStepResult {
  passed: boolean;
  detail: string[];
}

export interface PortabilityValidationAdapter {
  inspectTarget(input: FrozenValidationInput): Promise<ValidationTargetInspection>;
  verifyArtifacts(input: FrozenValidationInput): Promise<ValidationStepResult>;
  verifyIdentityAndSecrets(input: FrozenValidationInput): Promise<ValidationStepResult>;
  startTemporaryReplica(input: FrozenValidationInput): Promise<TemporaryReplicaResult>;
  exerciseReconciliation(input: FrozenValidationInput): Promise<ValidationStepResult>;
  buildWithoutNetwork(input: FrozenValidationInput): Promise<ValidationStepResult>;
  cleanup(input: FrozenValidationInput): Promise<void>;
}

export interface PortabilityValidationInput extends Omit<PortabilityAnalysisInput, 'target'> {
  configurationDigest: string;
  targetCapabilityDigest: string;
  checkpointId?: string;
  requiredArtifactDigests: string[];
  requireOfflineBuild: boolean;
  persist?: boolean;
}

export interface FrozenValidationInput {
  appId: string;
  siteId: string;
  specDigest: string;
  configurationDigest: string;
  targetCapabilityDigest: string;
  checkpointId?: string;
  requiredArtifactDigests: readonly string[];
  requireOfflineBuild: boolean;
  spec: ApplicationSpec;
  volumes: readonly PortabilityVolumeSnapshot[];
  inputDigest: string;
}

export interface PortabilityValidationProof {
  inputDigest: string;
  target: ValidationTargetInspection;
  artifacts: ValidationStepResult;
  identityAndSecrets: ValidationStepResult;
  temporaryReplica: TemporaryReplicaResult;
  reconciliation: ValidationStepResult;
  noNetworkBuild: ValidationStepResult | null;
  cleanupError?: string;
}

export interface PortabilityValidationResult {
  report: PortabilityReport;
  proof: PortabilityValidationProof;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function freezeInput(input: PortabilityValidationInput): FrozenValidationInput {
  const immutable = {
    appId: input.appId,
    siteId: input.siteId,
    specDigest: input.specDigest,
    configurationDigest: input.configurationDigest,
    targetCapabilityDigest: input.targetCapabilityDigest,
    checkpointId: input.checkpointId,
    requiredArtifactDigests: [...input.requiredArtifactDigests].sort(),
    requireOfflineBuild: input.requireOfflineBuild,
    spec: structuredClone(input.spec),
    volumes: input.volumes.map((volume) => ({ ...volume })),
  };
  return Object.freeze({ ...immutable, inputDigest: digest(immutable) });
}

function finding(
  id: string,
  dimension: CapabilityDimension,
  message: string,
  blocks: string[],
  evidence: string[],
): PortabilityFinding {
  return { id, dimension, severity: 'error', message, blocks, evidence };
}

function validationEvidence(
  siteId: string,
  inputDigest: string,
  detail: string,
  trust: PortabilityEvidence['trust'] = 'validated',
): PortabilityEvidence {
  return { trust, source: `validation-replica:${siteId}`, detail, digest: inputDigest };
}

function blockCapability(
  report: PortabilityReport,
  dimension: CapabilityDimension,
  item: PortabilityFinding,
): void {
  report.findings.push(item);
  report.capabilityVector[dimension] = {
    status: 'block',
    summary: item.message,
    evidence: item.evidence.map((detail) =>
      validationEvidence(report.siteId, report.specDigest, detail, 'observed'),
    ),
    findingIds: [...new Set([...report.capabilityVector[dimension].findingIds, item.id])],
  };
}

/**
 * Executes the target-local evidence pipeline. The adapter owns the temporary runtime, but this
 * orchestrator freezes all inputs, always cleans it up, and converts every failed proof into an
 * explicit capability blocker. A failed build blocks development readiness only; it does not turn
 * off an otherwise healthy portable runtime.
 */
export async function validatePortability(
  input: PortabilityValidationInput,
  adapter: PortabilityValidationAdapter,
): Promise<PortabilityValidationResult> {
  const frozen = freezeInput(input);
  let target: ValidationTargetInspection | undefined;
  let artifacts: ValidationStepResult | undefined;
  let identityAndSecrets: ValidationStepResult | undefined;
  let temporaryReplica: TemporaryReplicaResult | undefined;
  let reconciliation: ValidationStepResult | undefined;
  let noNetworkBuild: ValidationStepResult | null = null;
  let cleanupError: string | undefined;

  try {
    target = await adapter.inspectTarget(frozen);
    artifacts = await adapter.verifyArtifacts(frozen);
    identityAndSecrets = await adapter.verifyIdentityAndSecrets(frozen);
    temporaryReplica = await adapter.startTemporaryReplica(frozen);
    reconciliation = await adapter.exerciseReconciliation(frozen);
    if (input.requireOfflineBuild) noNetworkBuild = await adapter.buildWithoutNetwork(frozen);
  } finally {
    try {
      await adapter.cleanup(frozen);
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
    }
  }

  if (!target || !artifacts || !identityAndSecrets || !temporaryReplica || !reconciliation) {
    throw new Error('Portability validation ended before every runtime proof was recorded');
  }

  const requiredExternalDependency = temporaryReplica.externalDependencies.find(
    (dependency) => dependency.required,
  );
  const offlinePassed =
    temporaryReplica.healthPassed &&
    temporaryReplica.edgeRequestPassed &&
    !requiredExternalDependency;
  const report = analyzePortability({
    appId: input.appId,
    siteId: input.siteId,
    specDigest: input.specDigest,
    spec: input.spec,
    volumes: input.volumes,
    adapter: input.adapter,
    target: {
      platform: target.platform,
      architecture: target.architecture,
      compatibleArchitectures: target.compatibleArchitectures,
      runtimeAvailable: target.runtimeAvailable,
      requiredDevicesAvailable: target.requiredDevicesAvailable,
      containmentValidated: temporaryReplica.containmentEnforced,
      secretsMaterialized: identityAndSecrets.passed,
      artifactsMaterialized: artifacts.passed,
      offlineAccessValidated: offlinePassed,
      offlineBuildValidated: noNetworkBuild?.passed,
      reconciliationValidated: reconciliation.passed,
    },
  });

  report.evidence.push(
    validationEvidence(
      input.siteId,
      frozen.inputDigest,
      `Frozen validation input includes ${frozen.requiredArtifactDigests.length} artifact digest(s) and ${frozen.volumes.length} snapshot(s).`,
    ),
  );

  if (!temporaryReplica.containmentEnforced) {
    blockCapability(
      report,
      'runtimeContainment',
      finding(
        'RUNTIME.CONTAINMENT_VALIDATION_FAILED',
        'runtimeContainment',
        'The temporary replica did not enforce a read-only root and declared writable-state boundary.',
        ['Syncs across sites'],
        temporaryReplica.detail,
      ),
    );
  }
  if (!artifacts.passed) {
    blockCapability(
      report,
      'materialization',
      finding(
        'MATERIALIZATION.REQUIRED_ARTIFACT_MISSING',
        'materialization',
        'At least one release, image, source, checkpoint, blob, certificate, or rollback artifact is unavailable.',
        ['Ready offline', 'Ready to develop offline'],
        artifacts.detail,
      ),
    );
  }
  if (!identityAndSecrets.passed) {
    blockCapability(
      report,
      'identityAndSecrets',
      finding(
        'IDENTITY.REQUIRED_VALUE_UNAVAILABLE',
        'identityAndSecrets',
        'The target cannot decrypt or resolve every required identity/configuration value.',
        ['Ready offline'],
        identityAndSecrets.detail,
      ),
    );
  }
  if (!offlinePassed) {
    const evidence = requiredExternalDependency
      ? [requiredExternalDependency.destination, requiredExternalDependency.evidence]
      : temporaryReplica.detail;
    blockCapability(
      report,
      'offlineDependencies',
      finding(
        requiredExternalDependency
          ? 'OFFLINE.REQUIRED_REMOTE_SERVICE'
          : 'OFFLINE.TEMPORARY_REPLICA_FAILED',
        'offlineDependencies',
        requiredExternalDependency
          ? `A required dependency at ${requiredExternalDependency.destination} is unavailable while detached.`
          : 'The temporary replica did not pass startup, health, and edge routing with Home/internet denied.',
        ['Ready offline'],
        evidence,
      ),
    );
  }
  if (!reconciliation.passed && report.syncsAcrossSites) {
    blockCapability(
      report,
      'verification',
      finding(
        'DATA.RECONCILIATION_VALIDATION_FAILED',
        'verification',
        'Fork, diff, apply, integrity, or application validation failed for this exact release/profile.',
        ['Automatic sync', 'Manual sync'],
        reconciliation.detail,
      ),
    );
    report.syncsAcrossSites = false;
  }
  if (input.requireOfflineBuild && !noNetworkBuild?.passed) {
    blockCapability(
      report,
      'buildability',
      finding(
        'BUILD.MISSING_OFFLINE_DEPENDENCY',
        'buildability',
        'The current dependency graph did not rebuild with network access denied.',
        ['Ready to develop offline'],
        noNetworkBuild?.detail || ['No build proof returned'],
      ),
    );
  }
  if (cleanupError) {
    report.findings.push({
      id: 'VALIDATION.CLEANUP_INCOMPLETE',
      dimension: 'verification',
      severity: 'warning',
      message:
        'The temporary validation replica passed, but cleanup needs administrator attention.',
      blocks: [],
      evidence: [cleanupError],
    });
  }

  const proof: PortabilityValidationProof = {
    inputDigest: frozen.inputDigest,
    target,
    artifacts,
    identityAndSecrets,
    temporaryReplica,
    reconciliation,
    noNetworkBuild,
    cleanupError,
  };
  report.evidence.push(
    validationEvidence(input.siteId, frozen.inputDigest, `Validation proof ${digest(proof)}`),
  );
  if (input.persist !== false) persistPortabilityReport(report);
  return { report, proof };
}
