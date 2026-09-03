import { appendLocalFleetEvent, resolveLocalSiteId } from './multisite.ts';
import { getSqlite } from './store.ts';

export const MANUAL_DATA_SYNC_REQUESTED = 'suitcase.data.sync.requested';
export const MANUAL_DATA_SYNC_COMPLETED = 'suitcase.data.sync.completed';
export const MANUAL_DATA_SYNC_FAILED = 'suitcase.data.sync.failed';

const TERMINAL_OPERATIONS = new Set([MANUAL_DATA_SYNC_COMPLETED, MANUAL_DATA_SYNC_FAILED]);

interface StoredControlEvent {
  id: string;
  origin_site_id: string;
  app_id: string | null;
  actor: string;
  operation: string;
  payload: string;
  parent_event_id: string | null;
  created_at: string;
}

export interface ManualDataSyncRequest {
  id: string;
  appId: string;
  siteId: string;
  originSiteId: string;
  requestedBy: string;
  status: 'requested' | 'completed' | 'failed';
  requestedAt: string;
  completedAt: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
  retryOf: string | null;
}

export interface ManualDataSyncConsumption {
  requestId: string;
  appId: string;
  siteId: string;
  status: 'completed' | 'failed';
  error?: string;
  result?: Record<string, unknown>;
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

function controlRows(): StoredControlEvent[] {
  return getSqlite()!
    .prepare(
      `SELECT id, origin_site_id, app_id, actor, operation, payload,
              parent_event_id, created_at
         FROM fleet_events
        WHERE operation IN (?, ?, ?)
        ORDER BY created_at, id`,
    )
    .all(
      MANUAL_DATA_SYNC_REQUESTED,
      MANUAL_DATA_SYNC_COMPLETED,
      MANUAL_DATA_SYNC_FAILED,
    ) as StoredControlEvent[];
}

export function listManualDataSyncRequests(
  input: {
    appId?: string;
    siteId?: string;
    limit?: number;
  } = {},
): ManualDataSyncRequest[] {
  const rows = controlRows();
  const terminals = new Map<string, StoredControlEvent[]>();
  for (const row of rows) {
    if (!TERMINAL_OPERATIONS.has(row.operation) || !row.parent_event_id) continue;
    const group = terminals.get(row.parent_event_id) ?? [];
    group.push(row);
    terminals.set(row.parent_event_id, group);
  }
  return rows
    .filter((row) => row.operation === MANUAL_DATA_SYNC_REQUESTED && row.app_id)
    .map((row): ManualDataSyncRequest | null => {
      const payload = parsePayload(row.payload);
      const siteId = typeof payload.targetSiteId === 'string' ? payload.targetSiteId : '';
      if (!siteId) return null;
      const terminal = terminals
        .get(row.id)
        ?.filter((candidate) => {
          const candidatePayload = parsePayload(candidate.payload);
          return candidate.origin_site_id === siteId && candidatePayload.requestedSiteId === siteId;
        })
        .at(-1);
      const terminalPayload = terminal ? parsePayload(terminal.payload) : {};
      const status = terminal
        ? terminal.operation === MANUAL_DATA_SYNC_COMPLETED
          ? 'completed'
          : 'failed'
        : 'requested';
      return {
        id: row.id,
        appId: row.app_id!,
        siteId,
        originSiteId: row.origin_site_id,
        requestedBy: row.actor,
        status,
        requestedAt: row.created_at,
        completedAt: terminal?.created_at ?? null,
        error:
          status === 'failed' && typeof terminalPayload.error === 'string'
            ? terminalPayload.error
            : null,
        result:
          terminalPayload.result &&
          typeof terminalPayload.result === 'object' &&
          !Array.isArray(terminalPayload.result)
            ? (terminalPayload.result as Record<string, unknown>)
            : null,
        retryOf: typeof payload.retryOf === 'string' ? payload.retryOf : null,
      };
    })
    .filter((request): request is ManualDataSyncRequest => Boolean(request))
    .filter((request) => !input.appId || request.appId === input.appId)
    .filter((request) => !input.siteId || request.siteId === input.siteId)
    .reverse()
    .slice(0, input.limit ?? 100);
}

function effectiveReplicaPolicy(appId: string, siteId: string): string | undefined {
  const row = getSqlite()!
    .prepare(
      `SELECT COALESCE(site_policy.policy, app_policy.policy, replica.sync_policy,
                       site.default_data_policy, 'none') AS policy
         FROM app_replicas replica
         JOIN sites site ON site.id = replica.site_id
         LEFT JOIN data_sync_policies site_policy
           ON site_policy.app_id = replica.app_id AND site_policy.site_id = replica.site_id
         LEFT JOIN data_sync_policies app_policy
           ON app_policy.app_id = replica.app_id AND app_policy.site_id = ''
        WHERE replica.app_id = ? AND replica.site_id = ? AND replica.removed_at IS NULL`,
    )
    .get(appId, siteId) as { policy: string } | undefined;
  return row?.policy;
}

export function createManualDataSyncRequest(input: {
  appId: string;
  siteId: string;
  actor: string;
}): ManualDataSyncRequest & { reused: boolean } {
  const sqlite = getSqlite()!;
  const application = sqlite
    .prepare('SELECT name FROM deployments WHERE app_id = ?')
    .get(input.appId) as { name: string } | undefined;
  if (!application) throw new Error('Application not found');
  const site = sqlite
    .prepare(
      `SELECT id FROM sites
        WHERE id = ? AND kind = 'suitcase' AND credential_status = 'active'
          AND revoked_at IS NULL`,
    )
    .get(input.siteId) as { id: string } | undefined;
  if (!site) throw new Error('Active suitcase site not found');
  const policy = effectiveReplicaPolicy(input.appId, input.siteId);
  if (!policy) throw new Error('Application is not kept on this suitcase');
  if (policy !== 'manual')
    throw new Error('Sync now requires the suitcase data policy to be manual');

  const existing = listManualDataSyncRequests({ appId: input.appId, siteId: input.siteId }).find(
    (request) => request.status === 'requested',
  );
  if (existing) return { ...existing, reused: true };
  const retryOf = listManualDataSyncRequests({
    appId: input.appId,
    siteId: input.siteId,
    limit: 1,
  })[0];
  const event = appendLocalFleetEvent({
    originSiteId: resolveLocalSiteId(),
    appId: input.appId,
    actor: input.actor,
    operation: MANUAL_DATA_SYNC_REQUESTED,
    payload: {
      targetSiteId: input.siteId,
      deploymentName: application.name,
      explicitManual: true,
      retryOf: retryOf?.status === 'failed' ? retryOf.id : null,
    },
  });
  const created = listManualDataSyncRequests({ appId: input.appId, siteId: input.siteId }).find(
    (request) => request.id === event.eventId,
  );
  if (!created) throw new Error('Manual sync request could not be persisted');
  return { ...created, reused: false };
}

export function pendingManualDataSyncRequests(siteId: string): ManualDataSyncRequest[] {
  return listManualDataSyncRequests({ siteId })
    .filter((request) => request.status === 'requested')
    .reverse();
}

export function manualDataSyncControlTarget(
  event:
    | Pick<StoredControlEvent, 'operation' | 'payload'>
    | { operation: string; payload: unknown },
): string | undefined {
  if (
    event.operation !== MANUAL_DATA_SYNC_REQUESTED &&
    event.operation !== MANUAL_DATA_SYNC_COMPLETED &&
    event.operation !== MANUAL_DATA_SYNC_FAILED
  )
    return undefined;
  const payload =
    typeof event.payload === 'string'
      ? parsePayload(event.payload)
      : event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : {};
  return typeof payload.targetSiteId === 'string' ? payload.targetSiteId : undefined;
}

export function isManualDataSyncControlOperation(operation: string): boolean {
  return (
    operation === MANUAL_DATA_SYNC_REQUESTED ||
    operation === MANUAL_DATA_SYNC_COMPLETED ||
    operation === MANUAL_DATA_SYNC_FAILED
  );
}

function recordTerminal(input: {
  request: ManualDataSyncRequest;
  homeSiteId: string;
  status: 'completed' | 'failed';
  error?: string;
  result?: Record<string, unknown>;
}): void {
  appendLocalFleetEvent({
    originSiteId: input.request.siteId,
    appId: input.request.appId,
    actor: `system@${input.request.siteId}`,
    operation: input.status === 'completed' ? MANUAL_DATA_SYNC_COMPLETED : MANUAL_DATA_SYNC_FAILED,
    parentEventId: input.request.id,
    payload: {
      requestId: input.request.id,
      requestedSiteId: input.request.siteId,
      targetSiteId: input.homeSiteId,
      result: input.result ?? null,
      error: input.error ?? null,
    },
  });
}

export async function consumePendingManualDataSyncRequests(input: {
  siteId: string;
  homeSiteId: string;
  capture: (request: ManualDataSyncRequest) => Promise<Record<string, unknown> | void>;
  exchange: (request: ManualDataSyncRequest) => Promise<Record<string, unknown> | void>;
}): Promise<ManualDataSyncConsumption[]> {
  const results: ManualDataSyncConsumption[] = [];
  for (const request of pendingManualDataSyncRequests(input.siteId)) {
    try {
      const capture = await input.capture(request);
      const exchange = await input.exchange(request);
      const result = { capture: capture ?? null, exchange: exchange ?? null };
      recordTerminal({ request, homeSiteId: input.homeSiteId, status: 'completed', result });
      results.push({
        requestId: request.id,
        appId: request.appId,
        siteId: request.siteId,
        status: 'completed',
        result,
      });
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      recordTerminal({ request, homeSiteId: input.homeSiteId, status: 'failed', error });
      results.push({
        requestId: request.id,
        appId: request.appId,
        siteId: request.siteId,
        status: 'failed',
        error,
      });
    }
  }
  return results;
}
