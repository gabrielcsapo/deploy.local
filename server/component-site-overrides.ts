import { planApplicationExecution } from './application-execution.ts';
import { resolvePlacementTarget } from './application-placement-target.ts';
import { parseStoredApplicationSpec, type ApplicationSpec } from './application-spec.ts';
import {
  assertFleetMutationReady,
  destructiveGraphMutationFingerprint,
} from './fleet-mutation-guard.ts';
import { appendLocalFleetEvent, ensureFleetIdentity, resolveLocalSiteId } from './multisite.ts';
import {
  getApplicationSpecRevision,
  getComponentSiteOverrides,
  getSqlite,
  setComponentSiteOverride,
} from './store.ts';
import type { WireFleetEvent } from './suitcase-transport.ts';

export const COMPONENT_SITE_COUNT_UPDATED = 'application.component.site-count.updated';

interface ComponentSiteCountPayload {
  targetSiteId: string;
  deploymentName: string;
  componentKey: string;
  specDigest: string;
  instances: number | null;
  effectiveInstances: number;
  defaultInstances: number;
  previousEffectiveInstances: number;
}

interface ValidatedOverride {
  spec: ApplicationSpec;
  defaultInstances: number;
  previousEffectiveInstances: number;
  effectiveInstances: number;
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value) {
    throw new Error(`Component site-count event requires ${key}`);
  }
  return value;
}

function nullableInstances(payload: Record<string, unknown>): number | null {
  const value = payload.instances;
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 128) {
    throw new Error(
      'Component site-count event instances must be null or an integer from 1 to 128',
    );
  }
  return Number(value);
}

function validateOverride(input: {
  appId: string;
  deploymentName: string;
  targetSiteId: string;
  componentKey: string;
  specDigest: string;
  instances: number | null;
}): ValidatedOverride {
  const revision = getApplicationSpecRevision(input.deploymentName, input.specDigest);
  if (!revision)
    throw new Error('Component site count references an unavailable application revision');
  const spec = parseStoredApplicationSpec(revision.normalizedSpec);
  const component = spec.components[input.componentKey];
  if (!component) throw new Error(`Unknown application component ${input.componentKey}`);
  if (!component.siteOverrides.allowed) {
    throw new Error(`Component ${input.componentKey} does not allow site-specific instance counts`);
  }
  const effectiveInstances = input.instances ?? component.instances;
  if (
    effectiveInstances < component.siteOverrides.minimum ||
    effectiveInstances > component.siteOverrides.maximum
  ) {
    throw new Error(
      `Component ${input.componentKey} site count must be between ${component.siteOverrides.minimum} and ${component.siteOverrides.maximum}`,
    );
  }
  const overrides = getComponentSiteOverrides(input.appId, input.targetSiteId);
  const previousEffectiveInstances = overrides[input.componentKey] ?? component.instances;
  const admittedOverrides = { ...overrides };
  if (input.instances === null) delete admittedOverrides[input.componentKey];
  else admittedOverrides[input.componentKey] = input.instances;
  const admission = planApplicationExecution(input.appId, spec, {
    specDigest: input.specDigest,
    targetSiteId: input.targetSiteId,
    siteInstanceOverrides: admittedOverrides,
    placementTarget: resolvePlacementTarget(input.targetSiteId),
  });
  if (admission.blocked) {
    throw new Error(
      admission.findings
        .filter((finding) => finding.severity === 'error')
        .map((finding) => finding.message)
        .join('; ') || 'Target-local runtime admission rejected the site count',
    );
  }
  return {
    spec,
    defaultInstances: component.instances,
    previousEffectiveInstances,
    effectiveInstances,
  };
}

/**
 * Author one immutable Home control event and keep Home's remote-site projection in step with it.
 * The target repeats the graph admission check before persisting or touching its local runtime.
 */
export function publishComponentSiteCount(input: {
  appId: string;
  deploymentName: string;
  targetSiteId: string;
  componentKey: string;
  specDigest: string;
  instances: number | null;
  actor: string;
}): {
  eventId: string;
  effectiveInstances: number;
  defaultInstances: number;
  previousEffectiveInstances: number;
} {
  const fleet = ensureFleetIdentity();
  if (resolveLocalSiteId() !== fleet.homeSiteId || process.env.DEPLOY_SUITCASE === '1') {
    throw new Error('Only Home can author a remote site component count');
  }
  const sqlite = getSqlite()!;
  const target = sqlite
    .prepare(
      `SELECT id FROM sites
        WHERE id = ? AND fleet_id = ? AND kind = 'suitcase'
          AND credential_status = 'active' AND revoked_at IS NULL`,
    )
    .get(input.targetSiteId, fleet.id) as { id: string } | undefined;
  if (!target) throw new Error('Active target suitcase not found');
  const replica = sqlite
    .prepare(
      `SELECT id FROM app_replicas
        WHERE app_id = ? AND site_id = ? AND removed_at IS NULL`,
    )
    .get(input.appId, input.targetSiteId) as { id: string } | undefined;
  if (!replica) throw new Error('Application is not kept on the target suitcase');
  const deployment = sqlite
    .prepare(
      `SELECT name, desired_spec_digest, active_spec_digest, release_generation
         FROM deployments WHERE app_id = ?`,
    )
    .get(input.appId) as
    | {
        name: string;
        desired_spec_digest: string | null;
        active_spec_digest: string | null;
        release_generation: number;
      }
    | undefined;
  if (!deployment || deployment.name !== input.deploymentName) {
    throw new Error('Application identity does not match the requested component count');
  }
  const currentDigest = deployment.desired_spec_digest || deployment.active_spec_digest;
  if (currentDigest !== input.specDigest) {
    throw new Error('Application revision changed before the site count was authored');
  }
  const validated = validateOverride(input);
  if (validated.effectiveInstances < validated.previousEffectiveInstances) {
    assertFleetMutationReady({
      appId: input.appId,
      applicationName: input.deploymentName,
      kind: 'destructive-graph-change',
      mutationFingerprint: destructiveGraphMutationFingerprint(
        input.appId,
        `${input.specDigest}:site:${input.targetSiteId}:component:${encodeURIComponent(input.componentKey)}:instances:${validated.effectiveInstances}`,
      ),
      consequence: `This site-specific scale operation removes ${validated.previousEffectiveInstances - validated.effectiveInstances} ${input.componentKey} instance${validated.previousEffectiveInstances - validated.effectiveInstances === 1 ? '' : 's'} at ${input.targetSiteId}. Every selected suitcase must sync and acknowledge this exact operational change first.`,
      actor: input.actor,
    });
  }
  const payload: ComponentSiteCountPayload = {
    targetSiteId: input.targetSiteId,
    deploymentName: input.deploymentName,
    componentKey: input.componentKey,
    specDigest: input.specDigest,
    instances: input.instances,
    effectiveInstances: validated.effectiveInstances,
    defaultInstances: validated.defaultInstances,
    previousEffectiveInstances: validated.previousEffectiveInstances,
  };
  const event = appendLocalFleetEvent(
    {
      originSiteId: fleet.homeSiteId,
      appId: input.appId,
      actor: input.actor,
      operation: COMPONENT_SITE_COUNT_UPDATED,
      generation: deployment.release_generation,
      payload: payload as unknown as Record<string, unknown>,
    },
    () =>
      setComponentSiteOverride({
        appId: input.appId,
        deploymentName: input.deploymentName,
        siteId: input.targetSiteId,
        componentKey: input.componentKey,
        instances: input.instances,
        updatedBy: input.actor,
      }),
  );
  return {
    eventId: event.eventId,
    effectiveInstances: validated.effectiveInstances,
    defaultInstances: validated.defaultInstances,
    previousEffectiveInstances: validated.previousEffectiveInstances,
  };
}

/** Apply a verified Home event only to its named Suitcase after repeating local graph admission. */
export function projectComponentSiteCount(
  event: WireFleetEvent,
  context: { homeSiteId: string; localSiteId: string },
): void {
  if (event.operation !== COMPONENT_SITE_COUNT_UPDATED) return;
  if (event.originSiteId !== context.homeSiteId) {
    throw new Error('Only Home may author component site-count events');
  }
  if (!event.appId) throw new Error('Component site-count event requires an application id');
  const targetSiteId = requiredString(event.payload, 'targetSiteId');
  if (targetSiteId !== context.localSiteId) return;
  const deploymentName = requiredString(event.payload, 'deploymentName');
  const componentKey = requiredString(event.payload, 'componentKey');
  const specDigest = requiredString(event.payload, 'specDigest');
  const instances = nullableInstances(event.payload);
  const sqlite = getSqlite()!;
  const deployment = sqlite
    .prepare(
      `SELECT name, desired_spec_digest, active_spec_digest, release_generation
         FROM deployments WHERE app_id = ?`,
    )
    .get(event.appId) as
    | {
        name: string;
        desired_spec_digest: string | null;
        active_spec_digest: string | null;
        release_generation: number;
      }
    | undefined;
  if (!deployment || deployment.name !== deploymentName) {
    throw new Error('Component site-count event application identity is unavailable');
  }
  const currentDigest = deployment.desired_spec_digest || deployment.active_spec_digest;
  if (currentDigest !== specDigest || event.generation !== deployment.release_generation) {
    throw new Error('Component site-count event references a stale application revision');
  }
  const replica = sqlite
    .prepare(
      `SELECT id FROM app_replicas
        WHERE app_id = ? AND site_id = ? AND removed_at IS NULL`,
    )
    .get(event.appId, context.localSiteId) as { id: string } | undefined;
  if (!replica) throw new Error('Component site-count event targets an unselected application');
  const validated = validateOverride({
    appId: event.appId,
    deploymentName,
    targetSiteId,
    componentKey,
    specDigest,
    instances,
  });
  if (
    event.payload.effectiveInstances !== validated.effectiveInstances ||
    event.payload.defaultInstances !== validated.defaultInstances ||
    event.payload.previousEffectiveInstances !== validated.previousEffectiveInstances
  ) {
    throw new Error('Component site-count event facts do not match the target projection');
  }
  setComponentSiteOverride({
    appId: event.appId,
    deploymentName,
    siteId: context.localSiteId,
    componentKey,
    instances,
    updatedBy: event.actor,
  });
}
