import { appendLocalFleetEvent, ensureFleetIdentity } from './multisite.ts';
import { getSqlite } from './store.ts';
import type { ApplicationChangePlan } from './application-plan.ts';
import type { ApplicationSpec } from './application-spec.ts';

export const FLEET_MUTATION_REQUESTED = 'fleet.mutation.requested';
export const FLEET_MUTATION_ACKNOWLEDGED = 'fleet.mutation.acknowledged';

export type FleetMutationKind = 'application-delete' | 'destructive-graph-change';

interface StoredMutationEvent {
  id: string;
  origin_site_id: string;
  app_id: string | null;
  actor: string;
  operation: string;
  payload: string;
  parent_event_id: string | null;
  created_at: string;
}

interface ReplicaRow {
  site_id: string;
  site_name: string;
  mode: string;
  credential_status: string;
  revoked_at: string | null;
  last_contact_at: number | null;
  selection_token: string;
}

export interface FleetMutationReplicaStatus {
  siteId: string;
  siteName: string;
  mode: string;
  credentialStatus: string;
  revoked: boolean;
  lastContactAt: number | null;
  status: 'waiting' | 'acknowledged';
  acknowledgedAt: string | null;
}

export interface FleetMutationGate {
  ready: boolean;
  requestId: string | null;
  appId: string;
  applicationName: string;
  kind: FleetMutationKind;
  mutationFingerprint: string;
  consequence: string;
  replicas: FleetMutationReplicaStatus[];
  blockers: FleetMutationReplicaStatus[];
  instructions: {
    retry: string;
    removeLostReplicaApi: string;
    removeLostReplicaCli: string;
    warning: string;
  };
}

export class FleetMutationBlockedError extends Error {
  readonly code = 'fleet_acknowledgement_required';
  readonly status = 409;
  readonly gate: FleetMutationGate;

  constructor(gate: FleetMutationGate) {
    super(formatFleetMutationBlockedMessage(gate));
    this.name = 'FleetMutationBlockedError';
    this.gate = gate;
  }
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((candidate): candidate is string => typeof candidate === 'string')
    : [];
}

function mutationRows(): StoredMutationEvent[] {
  return getSqlite()!
    .prepare(
      `SELECT id, origin_site_id, app_id, actor, operation, payload,
              parent_event_id, created_at
         FROM fleet_events
        WHERE operation IN (?, ?)
        ORDER BY created_at, id`,
    )
    .all(FLEET_MUTATION_REQUESTED, FLEET_MUTATION_ACKNOWLEDGED) as StoredMutationEvent[];
}

function activeSuitcaseReplicas(appId: string): ReplicaRow[] {
  return getSqlite()!
    .prepare(
      `SELECT replica.site_id, site.name AS site_name, site.mode,
              site.credential_status, site.revoked_at,
              COALESCE(replica.last_contact_at, site.last_contact_at) AS last_contact_at,
              COALESCE(replica.last_policy_event_id, replica.created_at) AS selection_token
         FROM app_replicas replica
         JOIN sites site ON site.id = replica.site_id
        WHERE replica.app_id = ? AND replica.removed_at IS NULL
          AND site.kind = 'suitcase'
        ORDER BY site.name, replica.site_id`,
    )
    .all(appId) as ReplicaRow[];
}

function requestMatches(
  row: StoredMutationEvent,
  input: {
    appId: string;
    kind: FleetMutationKind;
    mutationFingerprint: string;
    activeReplicas: ReadonlyMap<string, string>;
    homeSiteId: string;
  },
): boolean {
  if (
    row.operation !== FLEET_MUTATION_REQUESTED ||
    row.origin_site_id !== input.homeSiteId ||
    row.app_id !== input.appId
  )
    return false;
  const payload = parsePayload(row.payload);
  if (payload.kind !== input.kind || payload.mutationFingerprint !== input.mutationFingerprint)
    return false;
  const targets = new Set(stringArray(payload.targetSiteIds));
  const tokens =
    payload.targetReplicaTokens &&
    typeof payload.targetReplicaTokens === 'object' &&
    !Array.isArray(payload.targetReplicaTokens)
      ? (payload.targetReplicaTokens as Record<string, unknown>)
      : {};
  // A replica explicitly removed after the request no longer owes an
  // acknowledgement. Existing acknowledgements from the remaining targets
  // stay valid. A newly selected replica, however, requires a new request.
  return [...input.activeReplicas].every(
    ([siteId, token]) => targets.has(siteId) && tokens[siteId] === token,
  );
}

function acknowledgedAt(
  rows: StoredMutationEvent[],
  requestId: string,
  siteId: string,
  mutationFingerprint: string,
): string | null {
  return (
    rows
      .filter(
        (row) =>
          row.operation === FLEET_MUTATION_ACKNOWLEDGED &&
          row.parent_event_id === requestId &&
          row.origin_site_id === siteId,
      )
      .filter((row) => {
        const payload = parsePayload(row.payload);
        return (
          payload.requestId === requestId &&
          payload.requestedSiteId === siteId &&
          payload.mutationFingerprint === mutationFingerprint
        );
      })
      .at(-1)?.created_at ?? null
  );
}

function buildGate(input: {
  appId: string;
  applicationName: string;
  kind: FleetMutationKind;
  mutationFingerprint: string;
  consequence: string;
  request: StoredMutationEvent | undefined;
  rows: StoredMutationEvent[];
  replicas: ReplicaRow[];
}): FleetMutationGate {
  const replicas = input.replicas.map((replica): FleetMutationReplicaStatus => {
    const acknowledged = input.request
      ? acknowledgedAt(input.rows, input.request.id, replica.site_id, input.mutationFingerprint)
      : null;
    return {
      siteId: replica.site_id,
      siteName: replica.site_name,
      mode: replica.mode,
      credentialStatus: replica.credential_status,
      revoked: Boolean(replica.revoked_at),
      lastContactAt: replica.last_contact_at,
      status: acknowledged ? 'acknowledged' : 'waiting',
      acknowledgedAt: acknowledged,
    };
  });
  const blockers = replicas.filter((replica) => replica.status === 'waiting');
  return {
    ready: blockers.length === 0,
    requestId: input.request?.id ?? null,
    appId: input.appId,
    applicationName: input.applicationName,
    kind: input.kind,
    mutationFingerprint: input.mutationFingerprint,
    consequence: input.consequence,
    replicas,
    blockers,
    instructions: {
      retry: 'Connect the listed suitcases, allow one successful sync, then retry this operation.',
      removeLostReplicaApi: `/api/fleet/apps/${encodeURIComponent(input.appId)}/remove-replica`,
      removeLostReplicaCli: `deploy suitcase remove-replica ${input.appId} {siteId} --confirm-data-loss`,
      warning:
        'Removing a lost replica permanently accepts that unreceived away data may be lost and quarantines that replica branch.',
    },
  };
}

function requireApplication(appId: string): { name: string } {
  const application = getSqlite()!
    .prepare('SELECT name FROM deployments WHERE app_id = ?')
    .get(appId) as { name: string } | undefined;
  if (!application) throw new Error('Application not found');
  return application;
}

export function inspectFleetMutation(input: {
  appId: string;
  applicationName?: string;
  kind: FleetMutationKind;
  mutationFingerprint: string;
  consequence: string;
}): FleetMutationGate {
  const application = input.applicationName
    ? { name: input.applicationName }
    : requireApplication(input.appId);
  const fleet = ensureFleetIdentity();
  const replicas = activeSuitcaseReplicas(input.appId);
  const rows = mutationRows();
  const activeReplicas = new Map(
    replicas.map((replica) => [replica.site_id, replica.selection_token]),
  );
  const request = rows
    .filter((row) =>
      requestMatches(row, {
        appId: input.appId,
        kind: input.kind,
        mutationFingerprint: input.mutationFingerprint,
        activeReplicas,
        homeSiteId: fleet.homeSiteId,
      }),
    )
    .at(-1);
  return buildGate({
    ...input,
    applicationName: application.name,
    request,
    rows,
    replicas,
  });
}

export function prepareFleetMutation(input: {
  appId: string;
  applicationName?: string;
  kind: FleetMutationKind;
  mutationFingerprint: string;
  consequence: string;
  actor: string;
}): FleetMutationGate {
  let gate = inspectFleetMutation(input);
  if (gate.ready || gate.requestId) return gate;
  const fleet = ensureFleetIdentity();
  appendLocalFleetEvent({
    originSiteId: fleet.homeSiteId,
    appId: input.appId,
    actor: input.actor,
    operation: FLEET_MUTATION_REQUESTED,
    payload: {
      kind: input.kind,
      mutationFingerprint: input.mutationFingerprint,
      applicationName: gate.applicationName,
      targetSiteIds: gate.replicas.map((replica) => replica.siteId),
      targetReplicaTokens: Object.fromEntries(
        activeSuitcaseReplicas(input.appId).map((replica) => [
          replica.site_id,
          replica.selection_token,
        ]),
      ),
      consequence: input.consequence,
    },
  });
  gate = inspectFleetMutation(input);
  if (!gate.requestId) throw new Error('Fleet mutation request could not be persisted');
  return gate;
}

export function assertFleetMutationReady(
  input: Parameters<typeof prepareFleetMutation>[0],
): FleetMutationGate {
  const gate = prepareFleetMutation(input);
  if (!gate.ready) throw new FleetMutationBlockedError(gate);
  return gate;
}

export function pendingFleetMutationRequests(siteId: string): Array<{
  requestId: string;
  appId: string;
  kind: FleetMutationKind;
  mutationFingerprint: string;
  consequence: string;
}> {
  const rows = mutationRows();
  const homeSiteId = ensureFleetIdentity().homeSiteId;
  return rows
    .filter(
      (row) =>
        row.operation === FLEET_MUTATION_REQUESTED &&
        row.origin_site_id === homeSiteId &&
        row.app_id,
    )
    .filter((row) => stringArray(parsePayload(row.payload).targetSiteIds).includes(siteId))
    .filter((row) => {
      const payload = parsePayload(row.payload);
      return !acknowledgedAt(rows, row.id, siteId, String(payload.mutationFingerprint || ''));
    })
    .filter((row) => {
      const replica = getSqlite()!
        .prepare(
          `SELECT 1 FROM app_replicas
            WHERE app_id = ? AND site_id = ? AND removed_at IS NULL`,
        )
        .get(row.app_id, siteId);
      return Boolean(replica);
    })
    .map((row) => {
      const payload = parsePayload(row.payload);
      return {
        requestId: row.id,
        appId: row.app_id!,
        kind: payload.kind as FleetMutationKind,
        mutationFingerprint: String(payload.mutationFingerprint || ''),
        consequence: String(payload.consequence || ''),
      };
    })
    .filter(
      (request) =>
        (request.kind === 'application-delete' || request.kind === 'destructive-graph-change') &&
        Boolean(request.mutationFingerprint),
    );
}

export function acknowledgePendingFleetMutationRequests(input: {
  siteId: string;
  homeSiteId: string;
}): string[] {
  const acknowledged: string[] = [];
  for (const request of pendingFleetMutationRequests(input.siteId)) {
    appendLocalFleetEvent({
      originSiteId: input.siteId,
      appId: request.appId,
      actor: `system@${input.siteId}`,
      operation: FLEET_MUTATION_ACKNOWLEDGED,
      parentEventId: request.requestId,
      payload: {
        requestId: request.requestId,
        requestedSiteId: input.siteId,
        targetSiteId: input.homeSiteId,
        kind: request.kind,
        mutationFingerprint: request.mutationFingerprint,
        consequenceAccepted: true,
      },
    });
    acknowledged.push(request.requestId);
  }
  return acknowledged;
}

export function fleetMutationControlTargets(event: {
  operation: string;
  payload: unknown;
}): string[] {
  if (
    event.operation !== FLEET_MUTATION_REQUESTED &&
    event.operation !== FLEET_MUTATION_ACKNOWLEDGED
  )
    return [];
  const payload =
    typeof event.payload === 'string'
      ? parsePayload(event.payload)
      : event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : {};
  return event.operation === FLEET_MUTATION_REQUESTED
    ? stringArray(payload.targetSiteIds)
    : typeof payload.targetSiteId === 'string'
      ? [payload.targetSiteId]
      : [];
}

export function isFleetMutationControlOperation(operation: string): boolean {
  return operation === FLEET_MUTATION_REQUESTED || operation === FLEET_MUTATION_ACKNOWLEDGED;
}

export function applicationDeleteMutationFingerprint(appId: string): string {
  return `application-delete:${appId}:v1`;
}

export function destructiveGraphMutationFingerprint(
  appId: string,
  candidateDigest: string,
): string {
  return `destructive-graph:${appId}:${candidateDigest}`;
}

/**
 * Fleet safety is broader than `plan.destructive`: a migration can preserve
 * every volume while still making an away replica's schema incompatible, and
 * a component removal/scale-down destroys runtime graph state.
 */
export function requiresFleetAcknowledgement(
  plan: ApplicationChangePlan | null | undefined,
  desired: ApplicationSpec,
): boolean {
  if (!plan) return false;
  if (
    plan.destructive ||
    plan.impacts.data.effect === 'destructive' ||
    plan.impacts.capacity.removedInstances > 0 ||
    plan.actions.some(
      (action) => action.classification === 'component-remove' || action.effect === 'migration',
    )
  )
    return true;
  return plan.actions.some((action) => {
    if (
      action.changedAddresses.some(
        (address) =>
          address.endsWith('/beforeTraffic') || address.endsWith('/rollout/schemaOverlap'),
      )
    )
      return true;
    if (
      action.classification !== 'component-recreate' &&
      action.classification !== 'component-rolling-restart'
    )
      return false;
    const match = action.address.match(/^\/components\/([^/]+)$/);
    if (!match) return false;
    const component = match[1]!.replaceAll('~1', '/').replaceAll('~0', '~');
    return desired.components[component]?.rollout.schemaOverlap === 'incompatible';
  });
}

export function formatFleetMutationBlockedMessage(gate: FleetMutationGate): string {
  const sites = gate.blockers
    .map((replica) => `${replica.siteName} (${replica.siteId}, ${replica.mode})`)
    .join(', ');
  return [
    `${gate.kind === 'application-delete' ? 'Application deletion' : 'Destructive graph change'} is waiting for ${gate.blockers.length} suitcase acknowledgement${gate.blockers.length === 1 ? '' : 's'}: ${sites}.`,
    gate.consequence,
    gate.instructions.retry,
    `For a permanently lost replica: ${gate.instructions.removeLostReplicaCli}`,
    gate.instructions.warning,
  ].join('\n');
}
