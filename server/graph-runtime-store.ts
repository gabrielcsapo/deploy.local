import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  actualVolumeAttachments,
  componentInstances,
  componentJobExecutions,
  componentPlacements,
  componentProfileOperations,
  componentProfileValues,
  componentProfileVolumeBindings,
  componentServices,
  serviceEndpoints,
} from './schema.ts';
import { getDb } from './store.ts';
import { notifyRouteChanged } from './ipc.ts';
import { decryptSecret, encryptSecret, loadOrCreateSecretKey } from './secrets.ts';

export type ComponentInstanceRow = typeof componentInstances.$inferSelect;
export type ComponentServiceRow = typeof componentServices.$inferSelect;
export type ComponentJobExecutionRow = typeof componentJobExecutions.$inferSelect;
export type ComponentProfileOperationRow = typeof componentProfileOperations.$inferSelect;
export type ComponentProfileVolumeBindingRow = typeof componentProfileVolumeBindings.$inferSelect;

export interface ReadyEndpointInput {
  id: string;
  instanceId: string;
  siteId: string;
  host: string;
  port: number;
  releaseDigest: string;
  configurationDigest: string;
}

export interface GraphRuntimeStateStore {
  upsertPlacement(input: typeof componentPlacements.$inferInsert): void;
  listInstances(appId: string, siteId: string, componentKey?: string): ComponentInstanceRow[];
  putInstance(input: typeof componentInstances.$inferInsert): void;
  patchInstance(id: string, patch: Partial<typeof componentInstances.$inferInsert>): void;
  upsertService(input: typeof componentServices.$inferInsert): void;
  replaceReadyEndpoints(
    deploymentName: string,
    serviceId: string,
    endpoints: readonly ReadyEndpointInput[],
    drainDeadline: number,
  ): number;
  getJobRecords(appId: string, siteId: string): ComponentJobExecutionRow[];
  startJob(input: typeof componentJobExecutions.$inferInsert): void;
  finishJob(key: string, status: 'succeeded' | 'failed', exitCode: number, output: string): void;
  replaceVolumeAttachments(
    instanceId: string,
    attachments: readonly (typeof actualVolumeAttachments.$inferInsert)[],
  ): void;
  startProfileOperation(input: typeof componentProfileOperations.$inferInsert): void;
  finishProfileOperation(
    id: string,
    status: 'succeeded' | 'failed',
    exitCode: number,
    output: string,
    verification?: string,
  ): void;
  patchProfileOperation(
    id: string,
    patch: Partial<typeof componentProfileOperations.$inferInsert>,
  ): void;
  findProfileArtifactOperation(input: {
    appId: string;
    siteId: string;
    componentKey: string;
    artifactDigest: string;
  }): ComponentProfileOperationRow | undefined;
  getProfileVolumeBinding(input: {
    appId: string;
    siteId: string;
    componentKey: string;
    resourceKey: string;
  }): ComponentProfileVolumeBindingRow | undefined;
  listProfileVolumeBindings(appId: string, siteId: string): ComponentProfileVolumeBindingRow[];
  commitProfileVolumeBinding(input: typeof componentProfileVolumeBindings.$inferInsert): void;
  restoreProfileVolumeBinding(
    address: { appId: string; siteId: string; componentKey: string; resourceKey: string },
    previous: ComponentProfileVolumeBindingRow | undefined,
  ): void;
  getOrCreateProfileValue(input: {
    appId: string;
    deploymentName: string;
    siteId: string;
    componentKey: string;
    key: string;
    secret: boolean;
    create: () => string;
  }): string;
}

export class DurableGraphRuntimeStore implements GraphRuntimeStateStore {
  upsertPlacement(input: typeof componentPlacements.$inferInsert): void {
    getDb()
      .insert(componentPlacements)
      .values(input)
      .onConflictDoUpdate({
        target: [
          componentPlacements.appId,
          componentPlacements.siteId,
          componentPlacements.componentKey,
        ],
        set: {
          deploymentName: input.deploymentName,
          desiredInstances: input.desiredInstances,
          defaultInstances: input.defaultInstances,
          minimumReady: input.minimumReady,
          rolloutStrategy: input.rolloutStrategy,
          maxSurge: input.maxSurge,
          maxUnavailable: input.maxUnavailable,
          placementIntent: input.placementIntent,
          capacity: input.capacity,
          releaseDigest: input.releaseDigest,
          configurationDigest: input.configurationDigest,
          generation: input.generation,
          state: input.state,
          profile: input.profile,
          updatedAt: input.updatedAt,
        },
      })
      .run();
  }

  listInstances(appId: string, siteId: string, componentKey?: string): ComponentInstanceRow[] {
    const predicate = componentKey
      ? and(
          eq(componentInstances.appId, appId),
          eq(componentInstances.siteId, siteId),
          eq(componentInstances.componentKey, componentKey),
        )
      : and(eq(componentInstances.appId, appId), eq(componentInstances.siteId, siteId));
    return getDb().select().from(componentInstances).where(predicate).all();
  }

  putInstance(input: typeof componentInstances.$inferInsert): void {
    getDb()
      .insert(componentInstances)
      .values(input)
      .onConflictDoUpdate({
        target: componentInstances.id,
        set: {
          containerId: input.containerId,
          status: input.status,
          health: input.health,
          drainDeadline: input.drainDeadline,
          readyAt: input.readyAt,
          updatedAt: input.updatedAt,
        },
      })
      .run();
  }

  patchInstance(id: string, patch: Partial<typeof componentInstances.$inferInsert>): void {
    getDb().update(componentInstances).set(patch).where(eq(componentInstances.id, id)).run();
  }

  upsertService(input: typeof componentServices.$inferInsert): void {
    getDb()
      .insert(componentServices)
      .values(input)
      .onConflictDoUpdate({
        target: componentServices.id,
        set: {
          deploymentName: input.deploymentName,
          componentKey: input.componentKey,
          interfaceKey: input.interfaceKey,
          protocol: input.protocol,
          containerPort: input.containerPort,
          published: input.published,
          updatedAt: input.updatedAt,
        },
      })
      .run();
  }

  replaceReadyEndpoints(
    deploymentName: string,
    serviceId: string,
    endpoints: readonly ReadyEndpointInput[],
    drainDeadline: number,
  ): number {
    const now = Date.now();
    const generation = getDb().transaction((tx) => {
      const service = tx
        .select({ generation: componentServices.membershipGeneration })
        .from(componentServices)
        .where(eq(componentServices.id, serviceId))
        .get();
      if (!service) throw new Error(`Unknown component service ${JSON.stringify(serviceId)}`);
      const nextGeneration = service.generation + 1;
      tx.update(serviceEndpoints)
        .set({
          readiness: 'draining',
          admittedGeneration: 0,
          drainDeadline,
          updatedAt: now,
        })
        .where(eq(serviceEndpoints.serviceId, serviceId))
        .run();
      for (const endpoint of endpoints) {
        tx.insert(serviceEndpoints)
          .values({
            ...endpoint,
            serviceId,
            readiness: 'ready',
            admittedGeneration: nextGeneration,
            drainDeadline: null,
            lastHealthAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: serviceEndpoints.id,
            set: {
              instanceId: endpoint.instanceId,
              siteId: endpoint.siteId,
              host: endpoint.host,
              port: endpoint.port,
              readiness: 'ready',
              releaseDigest: endpoint.releaseDigest,
              configurationDigest: endpoint.configurationDigest,
              admittedGeneration: nextGeneration,
              drainDeadline: null,
              lastHealthAt: now,
              updatedAt: now,
            },
          })
          .run();
      }
      tx.update(componentServices)
        .set({ membershipGeneration: nextGeneration, updatedAt: now })
        .where(eq(componentServices.id, serviceId))
        .run();
      return nextGeneration;
    });
    notifyRouteChanged(deploymentName);
    return generation;
  }

  getJobRecords(appId: string, siteId: string): ComponentJobExecutionRow[] {
    return getDb()
      .select()
      .from(componentJobExecutions)
      .where(
        and(eq(componentJobExecutions.appId, appId), eq(componentJobExecutions.siteId, siteId)),
      )
      .all();
  }

  startJob(input: typeof componentJobExecutions.$inferInsert): void {
    getDb()
      .insert(componentJobExecutions)
      .values(input)
      .onConflictDoUpdate({
        target: componentJobExecutions.idempotencyKey,
        set: {
          status: 'running',
          attempts: input.attempts,
          containerId: input.containerId,
          leaseOwner: input.leaseOwner,
          leaseExpiresAt: input.leaseExpiresAt,
          startedAt: input.startedAt,
          completedAt: null,
          exitCode: null,
          output: null,
          updatedAt: input.updatedAt,
        },
      })
      .run();
  }

  finishJob(key: string, status: 'succeeded' | 'failed', exitCode: number, output: string): void {
    const now = Date.now();
    getDb()
      .update(componentJobExecutions)
      .set({ status, exitCode, output: boundedOutput(output), completedAt: now, updatedAt: now })
      .where(eq(componentJobExecutions.idempotencyKey, key))
      .run();
  }

  replaceVolumeAttachments(
    instanceId: string,
    attachments: readonly (typeof actualVolumeAttachments.$inferInsert)[],
  ): void {
    getDb().transaction((tx) => {
      tx.delete(actualVolumeAttachments)
        .where(eq(actualVolumeAttachments.instanceId, instanceId))
        .run();
      if (attachments.length > 0)
        tx.insert(actualVolumeAttachments)
          .values([...attachments])
          .run();
    });
  }

  startProfileOperation(input: typeof componentProfileOperations.$inferInsert): void {
    getDb().transaction(
      (tx) => {
        const running = tx
          .select({ id: componentProfileOperations.id })
          .from(componentProfileOperations)
          .where(
            and(
              eq(componentProfileOperations.appId, input.appId),
              eq(componentProfileOperations.siteId, input.siteId),
              eq(componentProfileOperations.componentKey, input.componentKey),
              eq(componentProfileOperations.status, 'running'),
            ),
          )
          .get();
        if (running) {
          throw new Error(
            `Profile operation ${JSON.stringify(running.id)} is already running for component ${JSON.stringify(input.componentKey)}`,
          );
        }
        tx.insert(componentProfileOperations).values(input).run();
      },
      { behavior: 'immediate' },
    );
  }

  finishProfileOperation(
    id: string,
    status: 'succeeded' | 'failed',
    exitCode: number,
    output: string,
    verification?: string,
  ): void {
    const now = Date.now();
    getDb()
      .update(componentProfileOperations)
      .set({
        status,
        exitCode,
        output: boundedOutput(output),
        verification,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(componentProfileOperations.id, id))
      .run();
  }

  patchProfileOperation(
    id: string,
    patch: Partial<typeof componentProfileOperations.$inferInsert>,
  ): void {
    getDb()
      .update(componentProfileOperations)
      .set(patch)
      .where(eq(componentProfileOperations.id, id))
      .run();
  }

  findProfileArtifactOperation(input: {
    appId: string;
    siteId: string;
    componentKey: string;
    artifactDigest: string;
  }): ComponentProfileOperationRow | undefined {
    return getDb()
      .select()
      .from(componentProfileOperations)
      .where(
        and(
          eq(componentProfileOperations.appId, input.appId),
          eq(componentProfileOperations.siteId, input.siteId),
          eq(componentProfileOperations.componentKey, input.componentKey),
          eq(componentProfileOperations.artifactDigest, input.artifactDigest),
        ),
      )
      .orderBy(desc(componentProfileOperations.updatedAt))
      .get();
  }

  getProfileVolumeBinding(input: {
    appId: string;
    siteId: string;
    componentKey: string;
    resourceKey: string;
  }): ComponentProfileVolumeBindingRow | undefined {
    return getDb()
      .select()
      .from(componentProfileVolumeBindings)
      .where(
        and(
          eq(componentProfileVolumeBindings.appId, input.appId),
          eq(componentProfileVolumeBindings.siteId, input.siteId),
          eq(componentProfileVolumeBindings.componentKey, input.componentKey),
          eq(componentProfileVolumeBindings.resourceKey, input.resourceKey),
        ),
      )
      .get();
  }

  listProfileVolumeBindings(appId: string, siteId: string): ComponentProfileVolumeBindingRow[] {
    return getDb()
      .select()
      .from(componentProfileVolumeBindings)
      .where(
        and(
          eq(componentProfileVolumeBindings.appId, appId),
          eq(componentProfileVolumeBindings.siteId, siteId),
        ),
      )
      .all();
  }

  commitProfileVolumeBinding(input: typeof componentProfileVolumeBindings.$inferInsert): void {
    getDb()
      .insert(componentProfileVolumeBindings)
      .values(input)
      .onConflictDoUpdate({
        target: [
          componentProfileVolumeBindings.appId,
          componentProfileVolumeBindings.siteId,
          componentProfileVolumeBindings.componentKey,
          componentProfileVolumeBindings.resourceKey,
        ],
        set: {
          activeProviderVolume: input.activeProviderVolume,
          rollbackProviderVolume: input.rollbackProviderVolume,
          activeOperationId: input.activeOperationId,
          rollbackOperationId: input.rollbackOperationId,
          activeSpecDigest: input.activeSpecDigest,
          rollbackSpecDigest: input.rollbackSpecDigest,
          artifactDigest: input.artifactDigest,
          updatedAt: input.updatedAt,
        },
      })
      .run();
  }

  restoreProfileVolumeBinding(
    address: { appId: string; siteId: string; componentKey: string; resourceKey: string },
    previous: ComponentProfileVolumeBindingRow | undefined,
  ): void {
    if (previous) {
      this.commitProfileVolumeBinding(previous);
      return;
    }
    getDb()
      .delete(componentProfileVolumeBindings)
      .where(
        and(
          eq(componentProfileVolumeBindings.appId, address.appId),
          eq(componentProfileVolumeBindings.siteId, address.siteId),
          eq(componentProfileVolumeBindings.componentKey, address.componentKey),
          eq(componentProfileVolumeBindings.resourceKey, address.resourceKey),
        ),
      )
      .run();
  }

  getOrCreateProfileValue(input: {
    appId: string;
    deploymentName: string;
    siteId: string;
    componentKey: string;
    key: string;
    secret: boolean;
    create: () => string;
  }): string {
    const address = profileValueAddress(input);
    const secretKey = loadOrCreateSecretKey();
    const existing = getDb()
      .select()
      .from(componentProfileValues)
      .where(
        and(
          eq(componentProfileValues.appId, input.appId),
          eq(componentProfileValues.siteId, input.siteId),
          eq(componentProfileValues.componentKey, input.componentKey),
          eq(componentProfileValues.key, input.key),
        ),
      )
      .get();
    if (existing) {
      return existing.secret ? decryptSecret(existing.value, secretKey, address) : existing.value;
    }
    const value = input.create();
    const now = Date.now();
    getDb()
      .insert(componentProfileValues)
      .values({
        appId: input.appId,
        deploymentName: input.deploymentName,
        siteId: input.siteId,
        componentKey: input.componentKey,
        key: input.key,
        value: input.secret ? encryptSecret(value, secretKey, address) : value,
        valueDigest: `sha256:${createHash('sha256').update(`${address}\0${value}`).digest('hex')}`,
        secret: input.secret,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    const stored = getDb()
      .select()
      .from(componentProfileValues)
      .where(
        and(
          eq(componentProfileValues.appId, input.appId),
          eq(componentProfileValues.siteId, input.siteId),
          eq(componentProfileValues.componentKey, input.componentKey),
          eq(componentProfileValues.key, input.key),
        ),
      )
      .get();
    if (!stored) throw new Error('Unable to persist generated profile value');
    return stored.secret ? decryptSecret(stored.value, secretKey, address) : stored.value;
  }
}

function profileValueAddress(input: {
  appId: string;
  siteId: string;
  componentKey: string;
  key: string;
}): string {
  return `deploy.local/profile/${input.appId}/${input.siteId}/${input.componentKey}/${input.key}`;
}

function boundedOutput(output: string): string {
  const bytes = Buffer.from(output);
  return bytes.length <= 256 * 1024
    ? output
    : `${bytes.subarray(0, 256 * 1024).toString('utf8')}\n[output truncated]`;
}
