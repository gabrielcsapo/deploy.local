import { CatalogNotFoundError, CatalogService, type CatalogRuntimeAdapter } from './service.ts';
import { CatalogStoreConflictError } from './store.ts';
import type { CatalogTargetProfile } from './types.ts';

export interface CatalogHandlerRequest {
  method: 'GET' | 'POST';
  pathname: string;
  body?: unknown;
  actor: { username: string; role: 'admin' | 'user' };
}

export interface CatalogHandlerResponse {
  status: number;
  body: unknown;
}

export interface CatalogTargetResolver {
  list(): CatalogTargetProfile[] | Promise<CatalogTargetProfile[]>;
  resolve(siteId: string): CatalogTargetProfile | Promise<CatalogTargetProfile>;
}

/**
 * Mountable catalog API core. The main server owns authentication, JSON parsing,
 * request-size limits, and serialization; this handler owns catalog semantics.
 */
export async function handleCatalogRequest(
  service: CatalogService,
  request: CatalogHandlerRequest,
  runtime?: CatalogRuntimeAdapter,
  targetResolver?: CatalogTargetResolver,
): Promise<CatalogHandlerResponse> {
  if (request.actor.role !== 'admin') {
    return { status: 403, body: { error: 'Catalog operations require an administrator' } };
  }
  try {
    const url = new URL(request.pathname, 'http://catalog.local');
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (segments[0] !== 'catalog') return notFound();

    if (request.method === 'GET' && segments.length === 1) {
      return {
        status: 200,
        body: { releases: service.browse(url.searchParams.get('query') || '') },
      };
    }
    if (request.method === 'GET' && segments[1] === 'targets' && segments.length === 2) {
      if (!targetResolver) return unavailable('Catalog target discovery is unavailable');
      return { status: 200, body: { targets: await targetResolver.list() } };
    }
    if (request.method === 'POST' && segments[1] === 'compose-import' && segments.length === 2) {
      const body = record(request.body);
      if (typeof body.source !== 'string') return badRequest('Compose source is required');
      return {
        status: 200,
        body: service.composeImport(
          body.source,
          typeof body.applicationName === 'string' ? body.applicationName : undefined,
        ),
      };
    }
    if (segments[1] === 'installations' && segments.length === 2 && request.method === 'GET') {
      if (runtime) await service.reconcileRuntime(runtime);
      return { status: 200, body: { installations: service.installations() } };
    }
    if (segments[1] === 'installations' && segments.length === 3 && request.method === 'GET') {
      if (runtime) await service.reconcileRuntime(runtime);
      const installation = service.installation(segments[2]);
      return {
        status: 200,
        body: {
          installation,
          operations: service.operations(installation.id),
          recoveryPoints: service.recoveryPoints(installation.id),
        },
      };
    }
    if (segments[1] === 'installations' && segments.length === 4 && request.method === 'POST') {
      const installationId = segments[2];
      const operation = segments[3];
      const body = record(request.body);
      if (operation === 'detach-plan') {
        return { status: 200, body: service.detachPlan(installationId) };
      }
      if (operation === 'detach') {
        const plan = service.detachPlan(installationId);
        if (!plan.ready) return { status: 409, body: plan };
        return {
          status: 200,
          body: service.commitOwnershipPlan({
            plan,
            expectedRevision: integer(body.expectedRevision, 'expectedRevision'),
          }),
        };
      }
      if (operation === 'derive-plan') {
        if (typeof body.localBlueprintId !== 'string') {
          return badRequest('localBlueprintId is required');
        }
        return { status: 200, body: service.derivePlan(installationId, body.localBlueprintId) };
      }
      if (operation === 'derive') {
        const localBlueprintId = requiredString(body.localBlueprintId, 'localBlueprintId');
        const plan = service.derivePlan(installationId, localBlueprintId);
        if (!plan.ready) return { status: 409, body: plan };
        return {
          status: 200,
          body: service.commitOwnershipPlan({
            plan,
            localBlueprintId,
            expectedRevision: integer(body.expectedRevision, 'expectedRevision'),
          }),
        };
      }
      if (operation === 'upgrade-plan') {
        if (typeof body.toRelease !== 'string') return badRequest('toRelease is required');
        return {
          status: 200,
          body: service.upgradePlan({
            installationId,
            toRelease: body.toRelease,
            target: await requestTarget(body, targetResolver),
            answers: optionalRecord(body.answers),
          }),
        };
      }
      if (operation === 'upgrade') {
        if (!runtime) return unavailable();
        if (typeof body.toRelease !== 'string') return badRequest('toRelease is required');
        const answers = optionalRecord(body.answers);
        const plan = service.upgradePlan({
          installationId,
          toRelease: body.toRelease,
          target: await requestTarget(body, targetResolver),
          answers,
        });
        const result = await service.upgrade({
          plan,
          expectedRevision: integer(body.expectedRevision, 'expectedRevision'),
          actor: request.actor.username,
          runtime,
          answers,
          recoveryPointId: optionalString(body.recoveryPointId, 'recoveryPointId'),
        });
        return { status: result.operation.status === 'running' ? 202 : 200, body: result };
      }
      if (operation === 'rollback-plan') {
        return {
          status: 200,
          body: service.rollbackPlan(
            installationId,
            requiredString(body.recoveryPointId, 'recoveryPointId'),
          ),
        };
      }
      if (operation === 'rollback') {
        if (!runtime) return unavailable();
        const recoveryPointId = requiredString(body.recoveryPointId, 'recoveryPointId');
        const result = await service.rollback({
          plan: service.rollbackPlan(installationId, recoveryPointId),
          recoveryPointId,
          expectedRevision: integer(body.expectedRevision, 'expectedRevision'),
          actor: request.actor.username,
          runtime,
        });
        return { status: result.operation.status === 'running' ? 202 : 200, body: result };
      }
      if (operation === 'uninstall-plan') {
        return {
          status: 200,
          body: service.uninstallPlan(
            installationId,
            requiredBoolean(body.retainData, 'retainData'),
          ),
        };
      }
      if (operation === 'uninstall') {
        if (!runtime) return unavailable();
        const retainData = requiredBoolean(body.retainData, 'retainData');
        const result = await service.uninstall({
          plan: service.uninstallPlan(installationId, retainData),
          retainData,
          recoveryPointId: optionalString(body.recoveryPointId, 'recoveryPointId'),
          expectedRevision: integer(body.expectedRevision, 'expectedRevision'),
          actor: request.actor.username,
          runtime,
        });
        return { status: result.operation.status === 'running' ? 202 : 200, body: result };
      }
      if (operation === 'retry') {
        if (!runtime) return unavailable();
        const result = await service.retry({
          installationId,
          expectedRevision: integer(body.expectedRevision, 'expectedRevision'),
          actor: request.actor.username,
          runtime,
          answers: optionalRecord(body.answers),
        });
        return { status: result.operation.status === 'running' ? 202 : 200, body: result };
      }
      if (operation === 'recovery-points') {
        if (!runtime) return unavailable();
        const recoveryPoint = await service.createRecoveryPoint({
          installationId,
          actor: request.actor.username,
          runtime,
        });
        return {
          status: recoveryPoint.status === 'pending' ? 202 : 201,
          body: recoveryPoint,
        };
      }
      return notFound();
    }
    if (segments.length >= 3) {
      const id = segments[1];
      const release = segments[2];
      if (request.method === 'GET' && segments.length === 3) {
        return { status: 200, body: service.detail(id, release) };
      }
      if (request.method === 'POST' && segments.length === 4) {
        const body = record(request.body);
        const shared = {
          id,
          release,
          applicationName: requiredString(body.applicationName, 'applicationName'),
          target: await requestTarget(body, targetResolver),
          answers: optionalRecord(body.answers),
        };
        if (segments[3] === 'preflight') {
          return { status: 200, body: service.preflight(shared) };
        }
        if (segments[3] === 'install-plan') {
          return { status: 200, body: service.installPlan(shared) };
        }
        if (segments[3] === 'install') {
          if (!runtime) return unavailable();
          const plan = service.installPlan(shared);
          const result = await service.install({
            plan,
            applicationName: shared.applicationName,
            actor: request.actor.username,
            runtime,
            answers: shared.answers,
          });
          return { status: result.operation.status === 'running' ? 202 : 201, body: result };
        }
      }
    }
    return notFound();
  } catch (error) {
    if (error instanceof CatalogNotFoundError) {
      return { status: 404, body: { error: error.message } };
    }
    if (error instanceof CatalogStoreConflictError) {
      return { status: 409, body: { error: error.message } };
    }
    return { status: 400, body: { error: (error as Error).message } };
  }
}

function target(value: unknown): CatalogTargetProfile {
  const input = record(value);
  const capabilities = record(input.capabilities);
  return {
    siteId: requiredString(input.siteId, 'target.siteId'),
    ...(input.siteKind === undefined
      ? {}
      : {
          siteKind: enumeration(
            input.siteKind,
            ['coordinator', 'node', 'suitcase'],
            'target.siteKind',
          ),
        }),
    deployLocalVersion: requiredString(input.deployLocalVersion, 'target.deployLocalVersion'),
    operatingSystem: enumeration(
      input.operatingSystem,
      ['linux', 'darwin', 'windows'],
      'target.operatingSystem',
    ),
    architecture: enumeration(input.architecture, ['amd64', 'arm64'], 'target.architecture'),
    engine: enumeration(input.engine, ['docker-engine', 'docker-desktop'], 'target.engine'),
    engineVersion: requiredString(input.engineVersion, 'target.engineVersion'),
    memoryMiB: finiteNumber(input.memoryMiB, 'target.memoryMiB'),
    storageMiB: finiteNumber(input.storageMiB, 'target.storageMiB'),
    cpuCores: finiteNumber(input.cpuCores, 'target.cpuCores'),
    online: requiredBoolean(input.online, 'target.online'),
    cachedArtifactDigests: stringArray(input.cachedArtifactDigests, 'target.cachedArtifactDigests'),
    capabilities: {
      catalogExecution: requiredBoolean(
        capabilities.catalogExecution,
        'target.capabilities.catalogExecution',
      ),
      privilegedContainers: requiredBoolean(
        capabilities.privilegedContainers,
        'target.capabilities.privilegedContainers',
      ),
      hostNetwork: requiredBoolean(capabilities.hostNetwork, 'target.capabilities.hostNetwork'),
      lanDiscovery: requiredBoolean(capabilities.lanDiscovery, 'target.capabilities.lanDiscovery'),
      hostPaths: stringArray(capabilities.hostPaths, 'target.capabilities.hostPaths'),
      devices: stringArray(capabilities.devices, 'target.capabilities.devices'),
      dockerSocket: requiredBoolean(capabilities.dockerSocket, 'target.capabilities.dockerSocket'),
    },
  };
}

async function requestTarget(
  body: Record<string, unknown>,
  resolver?: CatalogTargetResolver,
): Promise<CatalogTargetProfile> {
  if (!resolver) return target(body.target);
  if (body.target !== undefined) {
    throw new Error(
      'target capability documents are derived by the server; send targetSiteId instead',
    );
  }
  return resolver.resolve(requiredString(body.targetSiteId, 'targetSiteId'));
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${path} is required`);
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`${path} must be a number`);
  return value;
}

function integer(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${path} must be a positive integer`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, path);
}

function requiredBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${path} must be a string array`);
  }
  return value;
}

function enumeration<const T extends string>(value: unknown, values: T[], path: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`${path} must be one of ${values.join(', ')}`);
  }
  return value as T;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Request body must be an object');
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value === undefined ? undefined : record(value);
}

function badRequest(message: string): CatalogHandlerResponse {
  return { status: 400, body: { error: message } };
}

function notFound(): CatalogHandlerResponse {
  return { status: 404, body: { error: 'Catalog route not found' } };
}

function unavailable(
  message = 'Catalog runtime adapter is not configured',
): CatalogHandlerResponse {
  return { status: 501, body: { error: message } };
}
