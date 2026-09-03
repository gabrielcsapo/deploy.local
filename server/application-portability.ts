import { createHash } from 'node:crypto';
import { resolveApplicationConfiguration } from './application-configuration.ts';
import {
  ApplicationGraphExecutor,
  type GraphExecutorContext,
} from './application-graph-executor.ts';
import { applicationWriterSiteId } from './application-authority.ts';
import { buildApplicationGraphRuntime } from './application-runtime.ts';
import { resolvePlacementTarget } from './application-placement-target.ts';
import { parseStoredApplicationSpec } from './application-spec.ts';
import { appendLocalFleetEvent, ensureFleetIdentity } from './multisite.ts';
import type { PortabilityReport } from './portability.ts';
import { RuntimePortabilityValidationAdapter } from './portability-validation-runtime.ts';
import {
  validatePortability,
  type PortabilityValidationAdapter,
  type ValidationTargetInspection,
} from './portability-validation.ts';
import {
  ensureApplicationRevisionArtifacts,
  getApplicationSpecRevision,
  getSqlite,
} from './store.ts';
import {
  inspectQuiescedApplicationVolumes,
  type SuitcaseDataExecutor,
} from './suitcase-data-bridge.ts';

interface ApplicationPortabilityRow {
  name: string;
  active_spec_digest: string | null;
  desired_spec_digest: string | null;
  directory: string | null;
  memory_limit: string | null;
  cpu_limit: string | null;
  source_artifact_digest: string | null;
  image_artifact_digest: string | null;
  snapshot_artifact_digest: string | null;
}

interface PortabilitySiteRow {
  platform: string | null;
  architecture: string | null;
  capabilities: string;
  credential_status: string;
  removed_at: number | null;
  revoked_at: string | null;
}

/**
 * Analyze an exact Home release from a cold managed-volume snapshot for one
 * selected Suitcase target. The report is persisted at Home and sent as a
 * signed, non-secret fleet event so the target uses the identical profile.
 */
export async function analyzeApplicationForSuitcase(input: {
  appId: string;
  siteId: string;
  actor: string;
  executor?: SuitcaseDataExecutor;
  /** Test/alternate-runtime seam; production always uses the isolated Docker adapter. */
  validationAdapter?: PortabilityValidationAdapter;
}): Promise<PortabilityReport> {
  const sqlite = getSqlite()!;
  const fleet = ensureFleetIdentity();
  const application = sqlite
    .prepare(
      `SELECT name, active_spec_digest, desired_spec_digest, directory, memory_limit, cpu_limit,
              source_artifact_digest, image_artifact_digest, snapshot_artifact_digest
         FROM deployments WHERE app_id = ?`,
    )
    .get(input.appId) as ApplicationPortabilityRow | undefined;
  if (!application) throw new Error('Application not found');
  const site = sqlite
    .prepare(
      `SELECT platform, architecture, capabilities, credential_status, removed_at, revoked_at
         FROM sites WHERE id = ? AND fleet_id = ? AND kind = 'suitcase'`,
    )
    .get(input.siteId, fleet.id) as PortabilitySiteRow | undefined;
  if (!site || site.revoked_at || site.removed_at || site.credential_status !== 'active') {
    throw new Error('Active suitcase site not found');
  }

  ensureApplicationRevisionArtifacts();
  const specDigest = application.active_spec_digest || application.desired_spec_digest;
  const revision = specDigest
    ? getApplicationSpecRevision(application.name, specDigest)
    : undefined;
  if (!revision) throw new Error('Portability analysis requires an immutable application revision');
  const spec = parseStoredApplicationSpec(revision.normalizedSpec);
  const homeConfiguration = resolveApplicationConfiguration({
    deploymentName: application.name,
    specDigest: revision.digest,
    declarations: spec.configuration,
    siteId: fleet.homeSiteId,
  });
  if (!homeConfiguration.ready) {
    throw new Error(`Home configuration is missing: ${homeConfiguration.missing.join(', ')}`);
  }
  const runtime = buildApplicationGraphRuntime({
    applicationId: input.appId,
    specDigest: revision.digest,
    spec,
    configuration: homeConfiguration,
  });
  if (!runtime.ready) throw new Error('Application graph is not admissible for volume analysis');
  const activeTransfer = sqlite
    .prepare(
      `SELECT id FROM volume_authority_transfers
        WHERE app_id = ? AND state NOT IN ('committed', 'failed', 'aborted') LIMIT 1`,
    )
    .get(input.appId) as { id: string } | undefined;
  if (activeTransfer) {
    throw new Error(
      `Portability analysis cannot run during writer transfer ${activeTransfer.id}; let the transfer finish or abort it`,
    );
  }
  const writerSiteId = applicationWriterSiteId(input.appId);
  if (writerSiteId && writerSiteId !== fleet.homeSiteId) {
    throw new Error(
      `Portability analysis must inspect the current writer at ${writerSiteId}; move authority to Home before analyzing another suitcase`,
    );
  }
  const context: GraphExecutorContext = {
    deploymentName: application.name,
    applicationId: input.appId,
    siteId: fleet.homeSiteId,
    nodeId: 'coordinator',
    projectDirectory: application.directory || process.cwd(),
    runtime,
    memoryLimit: application.memory_limit || '4g',
    cpuLimit: application.cpu_limit || undefined,
    writerSiteId,
  };
  const capabilities = parseCapabilities(site.capabilities);
  const catalog = record(capabilities.catalog);
  const availableDevices = new Set(stringArray(catalog.devices));
  const requiredDevices = Object.values(spec.components).flatMap((component) =>
    component.runtime.devices.map((device) => device.hostPath),
  );
  const targetConfiguration = resolveApplicationConfiguration({
    deploymentName: application.name,
    specDigest: revision.digest,
    declarations: spec.configuration,
    siteId: input.siteId,
  });
  const placementTarget = resolvePlacementTarget(input.siteId);
  if (!placementTarget) throw new Error('Suitcase placement evidence is unavailable');
  const requiredArtifactDigests = requiredArtifacts(sqlite, input.appId, {
    originalArtifactDigest: revision.originalArtifactDigest,
    normalizedArtifactDigest: revision.normalizedArtifactDigest,
    sourceArtifactDigest: application.source_artifact_digest,
    imageArtifactDigest: application.image_artifact_digest,
    snapshotArtifactDigest: application.snapshot_artifact_digest,
  });
  const targetInspection: ValidationTargetInspection = {
    platform: site.platform || 'unknown',
    architecture: site.architecture || 'unknown',
    compatibleArchitectures: site.architecture ? [site.architecture] : [],
    runtimeAvailable: capabilities.dockerTarget === true || capabilities.docker === true,
    requiredDevicesAvailable: requiredDevices.every((device) => availableDevices.has(device)),
    detail: [
      `Authenticated target facts from ${placementTarget.source}.`,
      `${requiredDevices.length} required device path(s) checked against the target catalog.`,
    ],
  };
  const graphExecutor = input.executor || new ApplicationGraphExecutor();

  const report = await inspectQuiescedApplicationVolumes({
    applicationId: input.appId,
    context,
    executor: graphExecutor,
    inspect: async (volumes) => {
      const adapter =
        input.validationAdapter ||
        new RuntimePortabilityValidationAdapter({
          context,
          configuration: targetConfiguration,
          placementTarget,
          targetInspection,
          requiredArtifactDigests,
          sourceArtifactDigest: validDigest(application.source_artifact_digest),
          executor: graphExecutor instanceof ApplicationGraphExecutor ? graphExecutor : undefined,
        });
      const validation = await validatePortability(
        {
          appId: input.appId,
          siteId: input.siteId,
          specDigest: revision.digest,
          configurationDigest: targetConfiguration.digest,
          targetCapabilityDigest: contentDigest({
            platform: site.platform,
            architecture: site.architecture,
            capabilities,
            placementLabels: placementTarget.labels,
          }),
          requiredArtifactDigests,
          requireOfflineBuild: Object.values(spec.components).some(
            (component) => component.build !== undefined,
          ),
          spec,
          volumes: [...volumes],
          persist: false,
        },
        adapter,
      );
      return validation.report;
    },
  });
  // `inspectQuiescedApplicationVolumes` persists the returned report only after the runtime has
  // resumed, keeping the signed profile aligned with an exact, safely captured data boundary.
  const { persistPortabilityReport } = await import('./portability.ts');
  persistPortabilityReport(report);
  sqlite
    .prepare(
      `UPDATE deployments SET reconciliation_profile_version = ?, updated_at = ?
        WHERE app_id = ?`,
    )
    .run(report.profileDigest, report.createdAt, input.appId);

  appendLocalFleetEvent({
    originSiteId: fleet.homeSiteId,
    appId: input.appId,
    actor: input.actor,
    operation: 'application.portability.reported',
    payload: portabilityReportPayload(report),
  });
  return report;
}

function requiredArtifacts(
  sqlite: NonNullable<ReturnType<typeof getSqlite>>,
  appId: string,
  release: {
    originalArtifactDigest?: string | null;
    normalizedArtifactDigest?: string | null;
    sourceArtifactDigest?: string | null;
    imageArtifactDigest?: string | null;
    snapshotArtifactDigest?: string | null;
  },
): string[] {
  const checkpoint = sqlite
    .prepare(
      `SELECT database_artifact_digest, filesystem_artifact_digest, manifest_artifact_digest
         FROM data_checkpoints
        WHERE app_id = ? AND verification_status = 'verified'
        ORDER BY sequence DESC LIMIT 1`,
    )
    .get(appId) as
    | {
        database_artifact_digest: string | null;
        filesystem_artifact_digest: string | null;
        manifest_artifact_digest: string;
      }
    | undefined;
  return [
    release.originalArtifactDigest,
    release.normalizedArtifactDigest,
    release.sourceArtifactDigest,
    release.imageArtifactDigest,
    release.snapshotArtifactDigest,
    checkpoint?.database_artifact_digest,
    checkpoint?.filesystem_artifact_digest,
    checkpoint?.manifest_artifact_digest,
  ]
    .filter((value): value is string => validDigest(value) !== undefined)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();
}

function validDigest(value: string | null | undefined): `sha256:${string}` | undefined {
  return value && /^sha256:[a-f0-9]{64}$/.test(value) ? (value as `sha256:${string}`) : undefined;
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

function contentDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

export function portabilityReportPayload(report: PortabilityReport): Record<string, unknown> {
  // Fleet payloads are a signed JSON contract. Strip optional `undefined`
  // members from analyzer structures before canonicalization so the durable
  // event remains valid JSON on every target runtime.
  return JSON.parse(
    JSON.stringify({
      targetSiteId: report.siteId,
      reportId: report.id,
      specDigest: report.specDigest,
      analyzerVersion: report.analyzerVersion,
      classification: report.classification,
      capabilityVector: report.capabilityVector,
      findings: report.findings,
      evidence: report.evidence,
      profileDigest: report.profileDigest,
      reconciliationProfile: report.reconciliationProfile,
      createdAt: report.createdAt,
    }),
  ) as Record<string, unknown>;
}

function parseCapabilities(value: string): Record<string, unknown> {
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
