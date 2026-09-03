import type { ApplicationSpec, SuitcaseDataMode } from './application-spec.ts';
import { parseStoredApplicationSpec } from './application-spec.ts';
import { getApplicationSpecRevision, getSqlite } from './store.ts';

export class SuitcaseDataModeContractError extends Error {
  readonly code: 'suitcase_data_contract_unavailable' | 'suitcase_data_mode_not_allowed';
  readonly status = 409;
  readonly statusCode = 409;
  readonly appId: string;
  readonly mode: SuitcaseDataMode;
  readonly resources: readonly string[];

  constructor(input: {
    code: SuitcaseDataModeContractError['code'];
    appId: string;
    mode: SuitcaseDataMode;
    resources?: readonly string[];
    message: string;
  }) {
    super(input.message);
    this.name = 'SuitcaseDataModeContractError';
    this.code = input.code;
    this.appId = input.appId;
    this.mode = input.mode;
    this.resources = input.resources ?? [];
  }
}

/** Enforce the resource contract from the exact immutable graph being admitted. */
export function assertSuitcaseDataModeAllowedBySpec(
  appId: string,
  applicationName: string,
  spec: ApplicationSpec,
  mode: SuitcaseDataMode,
): void {
  const resources = Object.entries(spec.resources)
    .filter(([, resource]) => !resource.suitcase.allowedDataModes.includes(mode))
    .map(([resource]) => resource)
    .sort();
  if (resources.length > 0) {
    throw new SuitcaseDataModeContractError({
      code: 'suitcase_data_mode_not_allowed',
      appId,
      mode,
      resources,
      message: `Suitcase data mode ${JSON.stringify(mode)} is not allowed by application ${JSON.stringify(applicationName)} resources: ${resources.join(', ')}`,
    });
  }
}

/**
 * Resolve the immutable desired graph and fail closed when its volume contract
 * rejects an operational Suitcase data topology. A deployment with no graph
 * source is explicitly legacy: even if an older row happens to carry a release
 * digest, it has no public resource contract to enforce.
 */
export function assertApplicationSuitcaseDataMode(
  appId: string,
  mode: SuitcaseDataMode,
): ApplicationSpec | null {
  const deployment = getSqlite()!
    .prepare(
      `SELECT name, desired_spec_digest, active_spec_digest, spec_source
         FROM deployments WHERE app_id = ?`,
    )
    .get(appId) as
    | {
        name: string;
        desired_spec_digest: string | null;
        active_spec_digest: string | null;
        spec_source: string | null;
      }
    | undefined;
  if (!deployment) throw new Error('Application not found');
  if (!deployment.spec_source) return null;
  const digest = deployment.desired_spec_digest || deployment.active_spec_digest;
  const revision = digest ? getApplicationSpecRevision(deployment.name, digest) : undefined;
  if (!revision) {
    throw new SuitcaseDataModeContractError({
      code: 'suitcase_data_contract_unavailable',
      appId,
      mode,
      message: `Application ${JSON.stringify(deployment.name)} cannot select Suitcase data mode ${JSON.stringify(mode)} because its desired immutable graph is unavailable`,
    });
  }
  const spec = parseStoredApplicationSpec(revision.normalizedSpec);
  assertSuitcaseDataModeAllowedBySpec(appId, deployment.name, spec, mode);
  return spec;
}
