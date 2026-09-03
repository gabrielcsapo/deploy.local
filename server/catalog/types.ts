import type { ApplicationManifest, ApplicationSpec } from '../application-spec.ts';
import type { ApplicationChangePlan } from '../application-plan.ts';

export const CATALOG_BLUEPRINT_SCHEMA = 'deploy.local/catalog-blueprint/v1' as const;

export type CatalogTrustTier = 'deploy-local' | 'community' | 'local-private';
export type CatalogReleaseStage = 'validation' | 'supported' | 'deprecated' | 'blocked';
export type CompatibilityClaim = 'verified' | 'declared' | 'not-supported' | 'unknown';
export type EvidenceResult = 'passed' | 'failed' | 'not-run';

export interface CatalogEvidence {
  id: string;
  kind:
    | 'schema'
    | 'signature'
    | 'install'
    | 'restart'
    | 'backup-restore'
    | 'upgrade-rollback'
    | 'offline-start'
    | 'security-review';
  result: EvidenceResult;
  target: string;
  summary: string;
  observedAt?: string;
  reference?: string;
}

export interface CatalogCompatibilityPromises {
  install: CompatibilityClaim;
  lifecycle: CompatibilityClaim;
  offline: CompatibilityClaim;
  suitcase: CompatibilityClaim;
  reconciliation: CompatibilityClaim;
}

export interface CatalogTargetConstraint {
  operatingSystems: Array<'linux' | 'darwin' | 'windows'>;
  architectures: Array<'amd64' | 'arm64'>;
  engines: Array<'docker-engine' | 'docker-desktop'>;
  minimumEngineVersion?: string;
  minimumMemoryMiB: number;
  minimumStorageMiB: number;
  minimumCpuCores: number;
  internetRequiredForInstall: boolean;
}

export interface CatalogSecurityGrant {
  id: string;
  kind:
    | 'privileged-container'
    | 'host-network'
    | 'host-path'
    | 'device'
    | 'docker-socket'
    | 'lan-discovery';
  component: string;
  required: boolean;
  value?: string;
  reason: string;
}

export interface CatalogArtifact {
  id: string;
  kind: 'oci-image' | 'sbom' | 'provenance';
  reference: string;
  digest: `sha256:${string}`;
  verification: 'resolved' | 'unresolved-fixture';
}

export interface CatalogQuestion {
  key: string;
  configuration: string;
  label: string;
  help?: string;
  required: boolean;
  secret: boolean;
}

export interface CatalogUpgradePath {
  fromRelease: string;
  recoveryPointRequired: boolean;
  rollback: 'supported' | 'before-migration-only' | 'not-supported';
  migrationJobs: string[];
  notes: string;
}

export interface CatalogBlueprintContent {
  schema: typeof CATALOG_BLUEPRINT_SCHEMA;
  id: string;
  release: string;
  publisher: {
    id: string;
    name: string;
    trustTier: CatalogTrustTier;
  };
  metadata: {
    name: string;
    summary: string;
    description: string;
    upstreamUrl?: string;
    supportUrl?: string;
    license: string;
    trademarkNotice?: string;
    categories: string[];
  };
  support: {
    stage: CatalogReleaseStage;
    scope: string;
    blockedReason?: string;
    evidence: CatalogEvidence[];
  };
  compatibility: {
    deployLocalVersion: string;
    target: CatalogTargetConstraint;
    promises: CatalogCompatibilityPromises;
  };
  security: CatalogSecurityGrant[];
  artifacts: CatalogArtifact[];
  questions: CatalogQuestion[];
  application: ApplicationManifest;
  supportedCustomization: string[];
  upgrades: CatalogUpgradePath[];
}

export interface CatalogBlueprintRelease extends CatalogBlueprintContent {
  contentDigest: `sha256:${string}`;
  signature: {
    algorithm: 'ed25519';
    keyId: string;
    value: string;
  };
}

export interface ValidatedCatalogRelease {
  release: CatalogBlueprintRelease;
  normalizedSpec: ApplicationSpec;
}

export interface CatalogTrustKey {
  keyId: string;
  publisherId: string;
  trustTier: CatalogTrustTier;
  publicKeyPem: string;
  revokedAt?: string;
  revocationReason?: string;
}

export interface CatalogTrustStore {
  keys: CatalogTrustKey[];
  allowedTrustTiers: CatalogTrustTier[];
}

export interface CatalogTargetProfile {
  siteId: string;
  /** Durable topology role, used for suitcase-specific compatibility promises. */
  siteKind?: 'coordinator' | 'node' | 'suitcase';
  deployLocalVersion: string;
  operatingSystem: 'linux' | 'darwin' | 'windows';
  architecture: 'amd64' | 'arm64';
  engine: 'docker-engine' | 'docker-desktop';
  engineVersion: string;
  memoryMiB: number;
  storageMiB: number;
  cpuCores: number;
  online: boolean;
  cachedArtifactDigests: string[];
  capabilities: {
    /** True only when this server can observe a terminal site-agent completion result. */
    catalogExecution: boolean;
    privilegedContainers: boolean;
    hostNetwork: boolean;
    lanDiscovery: boolean;
    hostPaths: string[];
    devices: string[];
    dockerSocket: boolean;
  };
}

export interface CatalogPreflightFinding {
  id: string;
  dimension:
    | 'release'
    | 'target'
    | 'capacity'
    | 'artifact'
    | 'configuration'
    | 'security'
    | 'offline'
    | 'suitcase';
  severity: 'info' | 'warning' | 'blocking';
  summary: string;
  remediation?: string;
}

export interface CatalogPreflightResult {
  blueprintId: string;
  release: string;
  siteId: string;
  ready: boolean;
  findings: CatalogPreflightFinding[];
  answerState: Record<
    string,
    { configured: boolean; secret: boolean; displayValue?: string | number | boolean }
  >;
  normalizedSpec: ApplicationSpec;
}

export interface CatalogOperationStep {
  id: string;
  phase:
    | 'preflight'
    | 'recovery-point'
    | 'materialize'
    | 'configure'
    | 'migrate'
    | 'health'
    | 'commit';
  summary: string;
  destructive: boolean;
  rollback: string;
}

export interface CatalogOperationPlan {
  planId: string;
  operation: 'install' | 'upgrade' | 'rollback' | 'uninstall' | 'detach' | 'derive';
  installationId?: string;
  blueprintId: string;
  fromRelease?: string;
  toRelease: string;
  localBlueprintId?: string;
  targetSiteId: string;
  ready: boolean;
  requiresApproval: boolean;
  destructive: boolean;
  blockers: CatalogPreflightFinding[];
  steps: CatalogOperationStep[];
  /** Shared semantic graph diff used by repository, UI, Compose, and offline promotion too. */
  changePlan: ApplicationChangePlan;
  normalizedSpec: ApplicationSpec;
  note: string;
}

export type CatalogInstallationMode = 'managed' | 'detached' | 'derived';
export type CatalogInstallationStatus =
  | 'installing'
  | 'healthy'
  | 'failed'
  | 'upgrading'
  | 'rolling-back'
  | 'uninstalling'
  | 'uninstalled';

export type CatalogRuntimeOperation = 'install' | 'upgrade' | 'rollback' | 'uninstall';
export type CatalogOperationStatus = 'running' | 'succeeded' | 'failed';
export type CatalogRecoveryPointStatus = 'pending' | 'verified' | 'failed';

export interface CatalogInstallation {
  id: string;
  applicationName: string;
  blueprintId: string;
  release: string;
  blueprintDigest: string;
  installedSpecDigest: string;
  currentSpecDigest: string;
  siteId: string;
  mode: CatalogInstallationMode;
  status: CatalogInstallationStatus;
  revision: number;
  driftedAddresses: string[];
  localBlueprintId?: string;
  lastOperationId?: string;
  failure?: string;
  dataRetained?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Durable intent journal for runtime work. Running rows are safe to resume after a restart. */
export interface CatalogOperation {
  id: string;
  installationId: string;
  applicationName: string;
  operation: CatalogRuntimeOperation;
  status: CatalogOperationStatus;
  plan: CatalogOperationPlan;
  attempt: number;
  actor: string;
  retainData?: boolean;
  recoveryPointId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/** A recovery point is usable only after the backing artifact has been independently verified. */
export interface CatalogRecoveryPoint {
  id: string;
  installationId: string;
  applicationName: string;
  siteId: string;
  release: string;
  specDigest: string;
  status: CatalogRecoveryPointStatus;
  artifactReference?: string;
  artifactDigest?: string;
  verification?: string;
  createdBy: string;
  createdAt: string;
  verifiedAt?: string;
}
