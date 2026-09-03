import { setDataSyncPolicy, type ConflictPolicy } from './data-reconciliation.ts';
import { SuitcaseDataModeContractError } from './application-data-contract.ts';
import { analyzeApplicationForSuitcase } from './application-portability.ts';
import {
  DataPolicyTransitionError,
  transitionReplicaDataPolicy,
  type DataPolicyRejoinChoice,
} from './data-policy-transitions.ts';
import {
  discardReleaseCandidate,
  evaluateReplicaReadiness,
  planReleaseCandidateChange,
  promoteReleaseCandidate,
} from './fleet-release.ts';
import { keepApplicationOnSuitcase, removeLostApplicationReplica } from './fleet-replicas.ts';
import {
  createSuitcasePairing,
  listTopology,
  revokeSite,
  type DataSyncPolicy,
} from './multisite.ts';
import {
  persistSuitcaseCapacityPlan,
  planSuitcaseCapacity,
  type SuitcaseCapacityInput,
} from './portability.ts';
import { resolveAndMaterializeDataConflict } from './reconciliation-coordinator.ts';
import { getSqlite } from './store.ts';
import { suitcaseAccessDiagnostics, suitcaseSyncStatus } from './suitcase-transport.ts';
import { createManualDataSyncRequest, listManualDataSyncRequests } from './manual-data-sync.ts';
import { capacityInputFromSelection, type CapacitySelectionRequest } from './suitcase-capacity.ts';
import {
  abortOpaqueVolumeAuthorityTransfer,
  getOpaqueVolumeAuthorityTransfer,
  listOpaqueVolumeAuthorityTransfers,
  planOpaqueVolumeAuthorityTransfer,
  processLocalOpaqueVolumeAuthorityTransfers,
  startOpaqueVolumeAuthorityTransfer,
} from './volume-sync.ts';

export interface FleetHandlerRequest {
  method: 'GET' | 'POST';
  pathname: string;
  body?: unknown;
  actor: { username: string; role: 'admin' | 'user' };
}

export interface FleetHandlerResponse {
  status: number;
  body: unknown;
}

function parseJson(value: unknown, fallback: unknown) {
  try {
    return JSON.parse(String(value ?? JSON.stringify(fallback)));
  } catch {
    return fallback;
  }
}

export function getFleetOverview() {
  const topology = listTopology();
  const sqlite = getSqlite()!;
  const replicas: Array<Record<string, unknown> & { readiness: unknown }> = (
    sqlite
      .prepare(
        `SELECT r.*, d.name,
                (SELECT COUNT(*) FROM data_conflicts c
                  WHERE c.app_id = r.app_id AND c.status = 'open') AS open_conflicts,
                (SELECT COUNT(*) FROM release_candidates rc
                  WHERE rc.app_id = r.app_id AND rc.state IN
                    ('candidate', 'ready-to-promote', 'missing-artifact', 'blocked-change',
                     'stale-generation', 'stale-authority')) AS release_candidates
           FROM app_replicas r
           JOIN deployments d ON d.app_id = r.app_id
          WHERE r.removed_at IS NULL
          ORDER BY r.site_id, d.name`,
      )
      .all() as Array<Record<string, unknown>>
  ).map((row): Record<string, unknown> & { readiness: unknown } => ({
    ...row,
    readiness: parseJson(row.readiness, {}),
  }));
  const reports = (
    sqlite
      .prepare(
        `SELECT p.* FROM portability_reports p
          WHERE p.created_at = (
            SELECT MAX(latest.created_at) FROM portability_reports latest
             WHERE latest.app_id = p.app_id AND latest.site_id = p.site_id
          )
          ORDER BY p.app_id, p.site_id`,
      )
      .all() as Array<Record<string, unknown>>
  ).map((row) => ({
    ...row,
    capability_vector: parseJson(row.capability_vector, {}),
    findings: parseJson(row.findings, []),
    evidence: parseJson(row.evidence, []),
  }));
  const policies = sqlite
    .prepare('SELECT * FROM data_sync_policies ORDER BY app_id, site_id')
    .all() as Array<Record<string, unknown>>;
  const conflicts = (
    sqlite
      .prepare(
        `SELECT c.id, c.app_id, d.name AS app_name, c.changeset_id, c.kind,
                c.logical_address, c.base_value, c.home_value, c.suitcase_value,
                c.status, c.created_at
           FROM data_conflicts c
           JOIN deployments d ON d.app_id = c.app_id
          WHERE c.status = 'open' ORDER BY c.created_at DESC`,
      )
      .all() as Array<Record<string, unknown>>
  ).map((conflict) => ({
    ...conflict,
    base_value: parseJson(conflict.base_value, null),
    home_value: parseJson(conflict.home_value, null),
    suitcase_value: parseJson(conflict.suitcase_value, null),
  }));
  const candidates = sqlite
    .prepare(
      `SELECT id, app_id, origin_site_id, base_authority_epoch, base_generation,
              architecture, state, created_at
         FROM release_candidates
        WHERE state NOT IN ('discarded', 'superseded') ORDER BY created_at DESC`,
    )
    .all() as Array<Record<string, unknown> & { id: string }>;
  const volumeSnapshots = sqlite
    .prepare(
      `SELECT snapshot.*
         FROM volume_snapshots snapshot
        WHERE NOT EXISTS (
          SELECT 1 FROM volume_snapshots newer
           WHERE newer.app_id = snapshot.app_id
             AND (newer.authority_epoch > snapshot.authority_epoch OR
                  (newer.authority_epoch = snapshot.authority_epoch AND
                   newer.data_sequence > snapshot.data_sequence))
        )
        ORDER BY snapshot.app_id`,
    )
    .all();
  const capacityPlan = sqlite
    .prepare('SELECT * FROM suitcase_capacity_plans ORDER BY created_at DESC LIMIT 1')
    .get() as Record<string, unknown> | undefined;
  return {
    ...topology,
    sites: topology.sites.map((site) => ({
      ...site,
      replicas: replicas.filter((replica) => String(replica.site_id) === site.id),
    })),
    replicas,
    reports,
    policies,
    conflicts,
    releaseCandidates: candidates.map((candidate) => ({
      ...candidate,
      plan: planReleaseCandidateChange(candidate.id),
    })),
    volumeSnapshots,
    writerTransfers: listOpaqueVolumeAuthorityTransfers(),
    manualSyncRequests: listManualDataSyncRequests(),
    capacityPlan: capacityPlan
      ? (() => {
          const measured = parseJson(capacityPlan.measured_result, {}) as Record<string, unknown>;
          return {
            ...capacityPlan,
            selected_app_ids: parseJson(capacityPlan.selected_app_ids, []),
            assumptions: parseJson(capacityPlan.assumptions, {}),
            contributors: parseJson(capacityPlan.contributors, []),
            unknowns: parseJson(capacityPlan.unknowns, []),
            measured_result: measured,
            evidenceSummary: measured.evidenceSummary || null,
            targetComparison: measured.targetComparison || null,
          };
        })()
      : null,
  };
}

function capacityNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`${path} must be a finite number`);
  return value;
}

export async function handleFleetRequest(
  request: FleetHandlerRequest,
): Promise<FleetHandlerResponse> {
  if (request.actor.role !== 'admin')
    return {
      status: 403,
      body: { error: 'Fleet and suitcase operations require an administrator' },
    };
  try {
    const url = new URL(request.pathname, 'http://fleet.local');
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (segments[0] !== 'fleet') return notFound();
    if (request.method === 'GET' && segments[1] === 'topology' && segments.length === 2)
      return { status: 200, body: getFleetOverview() };

    if (
      request.method === 'GET' &&
      segments[1] === 'writer-transfers' &&
      segments[2] &&
      segments.length === 3
    ) {
      return { status: 200, body: getOpaqueVolumeAuthorityTransfer(segments[2]) };
    }

    if (
      request.method === 'GET' &&
      segments[1] === 'sites' &&
      segments[2] &&
      segments[3] === 'diagnostics' &&
      segments.length === 4
    ) {
      return {
        status: 200,
        body: {
          access: suitcaseAccessDiagnostics(segments[2]),
          sync: suitcaseSyncStatus(segments[2]),
        },
      };
    }

    if (request.method === 'POST' && segments[1] === 'pairings' && segments.length === 2) {
      const body = record(request.body);
      return {
        status: 201,
        body: createSuitcasePairing({
          name: requiredString(body.name, 'name'),
          createdBy: request.actor.username,
          defaultDataPolicy:
            body.defaultDataPolicy === undefined
              ? undefined
              : dataSyncPolicy(body.defaultDataPolicy),
          accessMode:
            body.accessMode === undefined
              ? undefined
              : enumeration(
                  body.accessMode,
                  ['existing-lan', 'host-hotspot', 'linux-access-point'],
                  'accessMode',
                ),
          securityProfile:
            body.securityProfile === undefined
              ? undefined
              : enumeration(body.securityProfile, ['isolated', 'trusted-lan'], 'securityProfile'),
        }),
      };
    }

    if (
      request.method === 'POST' &&
      segments[1] === 'sites' &&
      segments[2] &&
      segments[3] === 'revoke' &&
      segments.length === 4
    ) {
      const body = record(request.body);
      revokeSite(segments[2], optionalString(body.reason) || 'Revoked by administrator');
      return { status: 200, body: { revoked: true, siteId: segments[2] } };
    }

    if (
      request.method === 'GET' &&
      segments[1] === 'apps' &&
      segments[2] &&
      segments[3] === 'sync' &&
      segments.length === 4
    ) {
      return {
        status: 200,
        body: {
          requests: listManualDataSyncRequests({
            appId: segments[2],
            siteId: optionalString(url.searchParams.get('siteId')),
          }),
        },
      };
    }

    if (
      request.method === 'POST' &&
      segments[1] === 'apps' &&
      segments[2] &&
      segments[3] === 'replicas' &&
      segments.length === 4
    ) {
      const body = record(request.body);
      const siteId = requiredString(body.siteId, 'siteId');
      const dataTopology =
        body.dataTopology === undefined
          ? undefined
          : enumeration(
              body.dataTopology,
              ['syncs-across-sites', 'follows-one-site', 'site-local'],
              'dataTopology',
            );
      const initialWriterSiteId = optionalString(body.initialWriterSiteId) || undefined;
      const selection = await keepApplicationOnSuitcase({
        appId: segments[2],
        siteId,
        policy: body.policy === undefined ? undefined : dataSyncPolicy(body.policy),
        dataTopology,
        initialWriterSiteId,
        conflictPolicy:
          body.conflictPolicy === undefined ? undefined : conflictPolicy(body.conflictPolicy),
        actor: request.actor.username,
      });
      let writerTransfer = null;
      if (dataTopology === 'follows-one-site' && initialWriterSiteId === siteId) {
        const plan = planOpaqueVolumeAuthorityTransfer({
          applicationId: segments[2],
          targetSiteId: siteId,
        });
        const transfer = startOpaqueVolumeAuthorityTransfer({
          applicationId: segments[2],
          targetSiteId: siteId,
          expectedSnapshotId: plan.expectedSnapshotId,
          expectedAuthorityEpoch: plan.expectedAuthorityEpoch,
          expectedDataSequence: plan.expectedDataSequence,
          actor: request.actor.username,
        });
        await processLocalOpaqueVolumeAuthorityTransfers({ transferId: transfer.id });
        writerTransfer = getOpaqueVolumeAuthorityTransfer(transfer.id);
      }
      return {
        status: 201,
        body: { ...selection, writerTransfer },
      };
    }

    if (
      request.method === 'POST' &&
      segments[1] === 'apps' &&
      segments[2] &&
      segments[3] === 'writer-transfer' &&
      segments[4] === 'plan' &&
      segments.length === 5
    ) {
      const body = record(request.body);
      return {
        status: 200,
        body: planOpaqueVolumeAuthorityTransfer({
          applicationId: segments[2],
          targetSiteId: requiredString(body.targetSiteId, 'targetSiteId'),
        }),
      };
    }

    if (
      request.method === 'POST' &&
      segments[1] === 'apps' &&
      segments[2] &&
      segments[3] === 'writer-transfer' &&
      segments[4] === 'start' &&
      segments.length === 5
    ) {
      const body = record(request.body);
      const transfer = startOpaqueVolumeAuthorityTransfer({
        applicationId: segments[2],
        targetSiteId: requiredString(body.targetSiteId, 'targetSiteId'),
        expectedSnapshotId: optionalString(body.expectedSnapshotId) || null,
        expectedAuthorityEpoch: requiredSafeInteger(
          body.expectedAuthorityEpoch,
          'expectedAuthorityEpoch',
        ),
        expectedDataSequence: requiredSafeInteger(
          body.expectedDataSequence,
          'expectedDataSequence',
        ),
        actor: request.actor.username,
      });
      await processLocalOpaqueVolumeAuthorityTransfers({ transferId: transfer.id });
      return {
        status: 202,
        body: getOpaqueVolumeAuthorityTransfer(transfer.id),
      };
    }

    if (
      request.method === 'POST' &&
      segments[1] === 'writer-transfers' &&
      segments[2] &&
      segments[3] === 'abort' &&
      segments.length === 4
    ) {
      const body = record(request.body);
      const transfer = abortOpaqueVolumeAuthorityTransfer({
        transferId: segments[2],
        actor: request.actor.username,
        reason: optionalString(body.reason),
      });
      await processLocalOpaqueVolumeAuthorityTransfers({ transferId: transfer.id });
      return { status: 200, body: getOpaqueVolumeAuthorityTransfer(transfer.id) };
    }

    if (
      request.method === 'POST' &&
      segments[1] === 'apps' &&
      segments[2] &&
      segments[3] === 'remove-replica' &&
      segments.length === 4
    ) {
      const body = record(request.body);
      return {
        status: 200,
        body: removeLostApplicationReplica({
          appId: segments[2],
          siteId: requiredString(body.siteId, 'siteId'),
          actor: request.actor.username,
          acknowledgeUnreceivedDataLoss: body.acknowledgeUnreceivedDataLoss === true,
        }),
      };
    }

    if (
      request.method === 'POST' &&
      segments[1] === 'apps' &&
      segments[2] &&
      segments[3] === 'sync' &&
      segments.length === 4
    ) {
      const body = record(request.body);
      const syncRequest = createManualDataSyncRequest({
        appId: segments[2],
        siteId: requiredString(body.siteId, 'siteId'),
        actor: request.actor.username,
      });
      return { status: syncRequest.reused ? 200 : 202, body: syncRequest };
    }

    if (
      request.method === 'POST' &&
      segments[1] === 'apps' &&
      segments[2] &&
      segments[3] === 'policy' &&
      segments.length === 4
    ) {
      const body = record(request.body);
      const siteId = optionalString(body.siteId);
      if (!siteId) {
        setDataSyncPolicy({
          appId: segments[2],
          policy: dataSyncPolicy(body.policy),
          conflictPolicy: conflictPolicy(body.conflictPolicy),
          acknowledgedRisks: stringArray(body.acknowledgedRisks, 'acknowledgedRisks', true),
          updatedBy: request.actor.username,
        });
        return { status: 200, body: { updated: true, scope: 'application-default' } };
      }
      const transition = transitionReplicaDataPolicy({
        appId: segments[2],
        siteId,
        policy: dataSyncPolicy(body.policy),
        conflictPolicy:
          body.conflictPolicy === undefined ? undefined : conflictPolicy(body.conflictPolicy),
        acknowledgedRisks: stringArray(body.acknowledgedRisks, 'acknowledgedRisks', true),
        rejoinChoice:
          body.rejoinChoice === undefined ? undefined : dataPolicyRejoinChoice(body.rejoinChoice),
        protectedConfirmation: optionalString(body.protectedConfirmation),
        updatedBy: request.actor.username,
      });
      return {
        status: transition.status === 'pending-target-processing' ? 202 : 200,
        body: transition,
      };
    }

    if (
      request.method === 'POST' &&
      segments[1] === 'apps' &&
      segments[2] &&
      segments[3] === 'portability-analysis' &&
      segments.length === 4
    ) {
      const body = record(request.body);
      return {
        status: 200,
        body: await analyzeApplicationForSuitcase({
          appId: segments[2],
          siteId: requiredString(body.siteId, 'siteId'),
          actor: request.actor.username,
        }),
      };
    }

    if (
      request.method === 'POST' &&
      segments[1] === 'apps' &&
      segments[2] &&
      segments[3] === 'readiness' &&
      segments.length === 4
    ) {
      const body = record(request.body);
      return {
        status: 200,
        body: evaluateReplicaReadiness({
          appId: segments[2],
          siteId: requiredString(body.siteId, 'siteId'),
          specDigest: requiredString(body.specDigest, 'specDigest'),
          checkpointId: optionalString(body.checkpointId),
          analyzerVersion: requiredString(body.analyzerVersion, 'analyzerVersion'),
          requireBuild: body.requireBuild === true,
        }),
      };
    }

    if (request.method === 'POST' && segments[1] === 'capacity-plans' && segments.length === 2) {
      const body = request.body as SuitcaseCapacityInput | CapacitySelectionRequest;
      if (!body || typeof body !== 'object' || Array.isArray(body))
        return badRequest('Plan input is required');
      const capacityInput = Array.isArray((body as SuitcaseCapacityInput).components)
        ? (body as SuitcaseCapacityInput)
        : capacityInputFromSelection({
            selectedAppIds: (stringArray(
              (body as CapacitySelectionRequest).selectedAppIds,
              'selectedAppIds',
            ) || []) as string[],
            tripHorizonDays: capacityNumber(
              (body as CapacitySelectionRequest).tripHorizonDays,
              'tripHorizonDays',
            ),
            offlineBuilds: (body as CapacitySelectionRequest).offlineBuilds === true,
            projectedDailyGrowthBytes:
              (body as CapacitySelectionRequest).projectedDailyGrowthBytes === undefined
                ? undefined
                : capacityNumber(
                    (body as CapacitySelectionRequest).projectedDailyGrowthBytes,
                    'projectedDailyGrowthBytes',
                  ),
            retainedBackupCopies:
              (body as CapacitySelectionRequest).retainedBackupCopies === undefined
                ? undefined
                : capacityNumber(
                    (body as CapacitySelectionRequest).retainedBackupCopies,
                    'retainedBackupCopies',
                  ),
            targetSiteId:
              typeof (body as CapacitySelectionRequest).targetSiteId === 'string'
                ? (body as CapacitySelectionRequest).targetSiteId
                : undefined,
            observationWindowDays:
              (body as CapacitySelectionRequest).observationWindowDays === undefined
                ? undefined
                : capacityNumber(
                    (body as CapacitySelectionRequest).observationWindowDays,
                    'observationWindowDays',
                  ),
          });
      const plan = planSuitcaseCapacity(capacityInput);
      persistSuitcaseCapacityPlan(plan);
      return { status: 201, body: plan };
    }

    if (
      request.method === 'POST' &&
      segments[1] === 'release-candidates' &&
      segments[2] &&
      segments[3] &&
      segments.length === 4
    ) {
      if (segments[3] === 'promote') {
        const body = record(request.body ?? {});
        return {
          status: 200,
          body: {
            generation: promoteReleaseCandidate({
              candidateId: segments[2],
              actor: request.actor.username,
              confirmDestructive: body.confirmDestructive === true,
            }),
          },
        };
      }
      if (segments[3] === 'discard') {
        discardReleaseCandidate(segments[2]);
        return { status: 200, body: { discarded: true } };
      }
    }

    if (
      request.method === 'POST' &&
      segments[1] === 'conflicts' &&
      segments[2] &&
      segments[3] === 'resolve' &&
      segments.length === 4
    ) {
      const body = record(request.body);
      const resolution = enumeration(
        body.resolution,
        ['home', 'suitcase', 'keep-both', 'custom'],
        'resolution',
      );
      const result = await resolveAndMaterializeDataConflict({
        conflictId: segments[2],
        resolution,
        resolvedBy: request.actor.username,
      });
      return { status: 200, body: result };
    }
    return notFound();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof DataPolicyTransitionError) {
      return { status: error.statusCode, body: { error: message, code: error.code } };
    }
    if (error instanceof SuitcaseDataModeContractError) {
      return {
        status: error.statusCode,
        body: {
          error: message,
          code: error.code,
          mode: error.mode,
          resources: error.resources,
        },
      };
    }
    return { status: /not found/i.test(message) ? 404 : 400, body: { error: message } };
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Request body must be an object');
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} is required`);
  return value.trim();
}

function requiredSafeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown, path: string, optional = false): string[] | undefined {
  if (value === undefined && optional) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
    throw new Error(`${path} must be a string array`);
  return value;
}

function enumeration<const T extends string>(value: unknown, values: T[], path: string): T {
  if (typeof value !== 'string' || !values.includes(value as T))
    throw new Error(`${path} must be one of ${values.join(', ')}`);
  return value as T;
}

function dataSyncPolicy(value: unknown): DataSyncPolicy {
  return enumeration(value, ['automatic', 'manual', 'none'], 'policy');
}

function dataPolicyRejoinChoice(value: unknown): DataPolicyRejoinChoice {
  return enumeration(
    value,
    ['replace-site-from-shared', 'replace-shared-from-site', 'import-site-as-new-application'],
    'rejoinChoice',
  );
}

function conflictPolicy(value: unknown): ConflictPolicy {
  if (value === undefined) return 'collect';
  return enumeration(value, ['collect', 'prefer-home', 'prefer-suitcase'], 'conflictPolicy');
}

function badRequest(message: string): FleetHandlerResponse {
  return { status: 400, body: { error: message } };
}

function notFound(): FleetHandlerResponse {
  return { status: 404, body: { error: 'Fleet route not found' } };
}
