import { assertCiMutation } from '../ci-fence.ts';
import { createHash } from 'node:crypto';
import {
  retainApplicationRevisionArtifact,
  getDb,
  refreshDeploymentInCache,
} from './connection.ts';
import {
  deployments,
  applicationSpecRevisions,
  applicationSpecTransitions,
  componentSiteOverrides,
  componentServices,
  componentPlacements,
  componentInstances,
  serviceEndpoints,
  componentJobExecutions,
  actualVolumeAttachments,
  componentProfileOperations,
  componentProfileVolumeBindings,
} from '../schema.ts';
import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import { getDeployment } from './deployments.ts';

export type ApplicationSpecRevisionSource = 'legacy' | 'repository' | 'ui' | 'catalog' | 'offline';

export interface ApplicationSpecRevisionInput {
  digest: string;
  deploymentName: string;
  parentDigest?: string | null;
  apiVersion: string;
  source: ApplicationSpecRevisionSource;
  manifestFormat: 'deploy.yaml' | 'generated';
  normalizedSpec: string;
  /** Exact author input when one exists (repository or generated YAML). */
  originalSource?: string;
  originalMediaType?: string;
  createdBy: string;
  createdAt?: string;
  /** Runtime states that must reject this transition while holding the same DB lock. */
  rejectDeploymentStatuses?: readonly string[];
}

/**
 * Record an immutable desired application revision. Replaying the same digest
 * is idempotent, which makes upload retries and suitcase event replay safe.
 */
export function saveDesiredApplicationSpec(revision: ApplicationSpecRevisionInput) {
  assertCiMutation(revision.deploymentName);
  const computedDigest = `sha256:${createHash('sha256')
    .update(revision.normalizedSpec)
    .digest('hex')}`;
  if (revision.digest !== computedDigest) {
    throw new Error('Application spec digest does not match its normalized content');
  }
  const normalizedArtifactDigest = retainApplicationRevisionArtifact(
    revision.normalizedSpec,
    'application-spec-normalized',
    'application/vnd.deploy.local.application+json',
  );
  const originalArtifactDigest = revision.originalSource
    ? retainApplicationRevisionArtifact(
        revision.originalSource,
        'application-spec-source',
        revision.originalMediaType || 'application/yaml',
      )
    : null;
  const db = getDb();
  const createdAt = revision.createdAt || new Date().toISOString();
  db.transaction(
    (tx) => {
      const deployment = tx
        .select({
          desiredSpecDigest: deployments.desiredSpecDigest,
          activeSpecDigest: deployments.activeSpecDigest,
          status: deployments.status,
        })
        .from(deployments)
        .where(eq(deployments.name, revision.deploymentName))
        .get();
      if (!deployment) throw new Error('Deployment not found');
      if (deployment.status && revision.rejectDeploymentStatuses?.includes(deployment.status)) {
        throw new Error(
          'Application revisions cannot change while a deploy or migration is switching runtime state',
        );
      }
      if (deployment.desiredSpecDigest === revision.digest) {
        // A repository may commit the exact normalized graph previously authored
        // in the UI/catalog/offline. This is an ancestry alignment event, not a
        // new runtime revision, but the durable projection must clear
        // "Not yet in source" without forcing a restart.
        if (revision.source === 'repository') {
          tx.update(deployments)
            .set({ specSource: 'repository', updatedAt: createdAt })
            .where(eq(deployments.name, revision.deploymentName))
            .run();
        }
        tx.update(applicationSpecRevisions)
          .set({
            normalizedArtifactDigest,
            ...(originalArtifactDigest ? { originalArtifactDigest } : {}),
          })
          .where(
            and(
              eq(applicationSpecRevisions.deploymentName, revision.deploymentName),
              eq(applicationSpecRevisions.digest, revision.digest),
            ),
          )
          .run();
        return;
      }
      const expectedParent = deployment.desiredSpecDigest || deployment.activeSpecDigest || null;
      if ((revision.parentDigest || null) !== expectedParent) {
        throw new Error('Application spec parent does not match the current desired revision');
      }
      tx.insert(applicationSpecRevisions)
        .values({
          digest: revision.digest,
          deploymentName: revision.deploymentName,
          parentDigest: revision.parentDigest || null,
          apiVersion: revision.apiVersion,
          source: revision.source,
          manifestFormat: revision.manifestFormat,
          normalizedSpec: revision.normalizedSpec,
          originalArtifactDigest,
          normalizedArtifactDigest,
          createdBy: revision.createdBy,
          createdAt,
        })
        .onConflictDoNothing({
          target: [applicationSpecRevisions.deploymentName, applicationSpecRevisions.digest],
        })
        .run();
      tx.insert(applicationSpecTransitions)
        .values({
          deploymentName: revision.deploymentName,
          fromDigest: expectedParent,
          toDigest: revision.digest,
          source: revision.source,
          createdBy: revision.createdBy,
          createdAt,
        })
        .run();
      tx.update(deployments)
        .set({
          desiredSpecDigest: revision.digest,
          specSource: revision.source,
          updatedAt: createdAt,
        })
        .where(eq(deployments.name, revision.deploymentName))
        .run();
    },
    // Prevent another connection from changing runtime state between the
    // status check and immutable transition write.
    { behavior: 'immediate' },
  );
  refreshDeploymentInCache(revision.deploymentName);
  return getApplicationSpecRevision(revision.deploymentName, revision.digest);
}

export function getApplicationSpecRevision(deploymentName: string, digest: string) {
  return getDb()
    .select()
    .from(applicationSpecRevisions)
    .where(
      and(
        eq(applicationSpecRevisions.deploymentName, deploymentName),
        eq(applicationSpecRevisions.digest, digest),
      ),
    )
    .get();
}

export function getApplicationSpecRevisions(deploymentName: string) {
  return getDb()
    .select()
    .from(applicationSpecRevisions)
    .where(eq(applicationSpecRevisions.deploymentName, deploymentName))
    .orderBy(desc(applicationSpecRevisions.createdAt))
    .all();
}

export function getApplicationSpecTransitions(deploymentName: string) {
  return getDb()
    .select()
    .from(applicationSpecTransitions)
    .where(eq(applicationSpecTransitions.deploymentName, deploymentName))
    .orderBy(desc(applicationSpecTransitions.id))
    .all();
}

export function getComponentSiteOverrides(appId: string, siteId: string): Record<string, number> {
  return Object.fromEntries(
    getDb()
      .select({
        component: componentSiteOverrides.componentKey,
        instances: componentSiteOverrides.instances,
      })
      .from(componentSiteOverrides)
      .where(
        and(eq(componentSiteOverrides.appId, appId), eq(componentSiteOverrides.siteId, siteId)),
      )
      .all()
      .map((row) => [row.component, row.instances]),
  );
}

export function listComponentSiteOverrides(appId: string) {
  return getDb()
    .select()
    .from(componentSiteOverrides)
    .where(eq(componentSiteOverrides.appId, appId))
    .orderBy(componentSiteOverrides.siteId, componentSiteOverrides.componentKey)
    .all();
}

export function setComponentSiteOverride(input: {
  appId: string;
  deploymentName: string;
  siteId: string;
  componentKey: string;
  instances: number | null;
  updatedBy: string;
}): void {
  if (input.instances === null) {
    getDb()
      .delete(componentSiteOverrides)
      .where(
        and(
          eq(componentSiteOverrides.appId, input.appId),
          eq(componentSiteOverrides.siteId, input.siteId),
          eq(componentSiteOverrides.componentKey, input.componentKey),
        ),
      )
      .run();
    return;
  }
  getDb()
    .insert(componentSiteOverrides)
    .values({
      ...input,
      instances: input.instances,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: [
        componentSiteOverrides.appId,
        componentSiteOverrides.siteId,
        componentSiteOverrides.componentKey,
      ],
      set: {
        deploymentName: input.deploymentName,
        instances: input.instances,
        updatedBy: input.updatedBy,
        updatedAt: new Date().toISOString(),
      },
    })
    .run();
}

/** Redacted durable actual-state projection for the graph-era application detail UI. */
export function getApplicationGraphState(deploymentName: string, appId: string, siteId: string) {
  const db = getDb();
  const services = db
    .select()
    .from(componentServices)
    .where(
      and(eq(componentServices.deploymentName, deploymentName), eq(componentServices.appId, appId)),
    )
    .all();
  const serviceIds = services.map((service) => service.id);
  return {
    placements: db
      .select()
      .from(componentPlacements)
      .where(
        and(
          eq(componentPlacements.deploymentName, deploymentName),
          eq(componentPlacements.appId, appId),
          eq(componentPlacements.siteId, siteId),
        ),
      )
      .all(),
    instances: db
      .select()
      .from(componentInstances)
      .where(
        and(
          eq(componentInstances.deploymentName, deploymentName),
          eq(componentInstances.appId, appId),
          eq(componentInstances.siteId, siteId),
        ),
      )
      .all(),
    services,
    endpoints:
      serviceIds.length === 0
        ? []
        : db
            .select()
            .from(serviceEndpoints)
            .where(
              and(
                inArray(serviceEndpoints.serviceId, serviceIds),
                eq(serviceEndpoints.siteId, siteId),
              ),
            )
            .all(),
    jobs: db
      .select()
      .from(componentJobExecutions)
      .where(
        and(
          eq(componentJobExecutions.deploymentName, deploymentName),
          eq(componentJobExecutions.appId, appId),
          eq(componentJobExecutions.siteId, siteId),
        ),
      )
      .all(),
    volumes: db
      .select()
      .from(actualVolumeAttachments)
      .where(
        and(
          eq(actualVolumeAttachments.deploymentName, deploymentName),
          eq(actualVolumeAttachments.appId, appId),
          eq(actualVolumeAttachments.siteId, siteId),
        ),
      )
      .all(),
    profileOperations: db
      .select({
        id: componentProfileOperations.id,
        componentKey: componentProfileOperations.componentKey,
        instanceId: componentProfileOperations.instanceId,
        profile: componentProfileOperations.profile,
        operation: componentProfileOperations.operation,
        status: componentProfileOperations.status,
        artifactDigest: componentProfileOperations.artifactDigest,
        artifactMediaType: componentProfileOperations.artifactMediaType,
        sourceSpecDigest: componentProfileOperations.sourceSpecDigest,
        targetSpecDigest: componentProfileOperations.targetSpecDigest,
        sourceVolume: componentProfileOperations.sourceVolume,
        targetVolume: componentProfileOperations.targetVolume,
        rollbackVolume: componentProfileOperations.rollbackVolume,
        evidence: componentProfileOperations.evidence,
        verification: componentProfileOperations.verification,
        exitCode: componentProfileOperations.exitCode,
        startedAt: componentProfileOperations.startedAt,
        completedAt: componentProfileOperations.completedAt,
        updatedAt: componentProfileOperations.updatedAt,
      })
      .from(componentProfileOperations)
      .where(
        and(
          eq(componentProfileOperations.deploymentName, deploymentName),
          eq(componentProfileOperations.appId, appId),
          eq(componentProfileOperations.siteId, siteId),
        ),
      )
      .all(),
    profileVolumeBindings: db
      .select()
      .from(componentProfileVolumeBindings)
      .where(
        and(
          eq(componentProfileVolumeBindings.appId, appId),
          eq(componentProfileVolumeBindings.siteId, siteId),
        ),
      )
      .all(),
  };
}

/** Compare-and-swap application revision metadata inside profile volume admission. */
export function transitionProfileApplicationSpec(input: {
  deploymentName: string;
  expectedActiveSpecDigest: string;
  expectedDesiredSpecDigest: string | null;
  targetActiveSpecDigest: string;
  targetDesiredSpecDigest: string | null;
  configurationDigest: string | null;
}): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.transaction(
    (tx) => {
      const deployment = tx
        .select({
          activeSpecDigest: deployments.activeSpecDigest,
          desiredSpecDigest: deployments.desiredSpecDigest,
        })
        .from(deployments)
        .where(eq(deployments.name, input.deploymentName))
        .get();
      if (!deployment) throw new Error('Deployment not found');
      if (
        deployment.activeSpecDigest !== input.expectedActiveSpecDigest ||
        deployment.desiredSpecDigest !== input.expectedDesiredSpecDigest
      ) {
        throw new Error('Application revision changed during profile volume admission');
      }
      const targetRevision = tx
        .select({ digest: applicationSpecRevisions.digest })
        .from(applicationSpecRevisions)
        .where(
          and(
            eq(applicationSpecRevisions.deploymentName, input.deploymentName),
            eq(applicationSpecRevisions.digest, input.targetActiveSpecDigest),
          ),
        )
        .get();
      if (!targetRevision) throw new Error('Target application revision not found');
      tx.update(deployments)
        .set({
          activeSpecDigest: input.targetActiveSpecDigest,
          desiredSpecDigest: input.targetDesiredSpecDigest,
          configurationDigest: input.configurationDigest,
          desiredReleaseDigest: input.targetActiveSpecDigest,
          releaseGeneration: sql`${deployments.releaseGeneration} + 1`,
          updatedAt: now,
        })
        .where(eq(deployments.name, input.deploymentName))
        .run();
    },
    { behavior: 'immediate' },
  );
  refreshDeploymentInCache(input.deploymentName);
}

/** Promote the desired revision only after its runtime passes admission. */
export function activateDesiredApplicationSpec(
  deploymentName: string,
  digest: string,
  configurationDigest: string | null = null,
) {
  assertCiMutation(deploymentName);
  const deployment = getDeployment(deploymentName);
  if (!deployment || deployment.desiredSpecDigest !== digest) {
    throw new Error('Application spec is no longer the desired revision');
  }
  if (!getApplicationSpecRevision(deploymentName, digest)) {
    throw new Error('Application spec revision not found');
  }
  getDb()
    .update(deployments)
    .set({
      activeSpecDigest: digest,
      configurationDigest,
      desiredReleaseDigest: digest,
      releaseGeneration: sql`${deployments.releaseGeneration} + 1`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(deployments.name, deploymentName))
    .run();
  refreshDeploymentInCache(deploymentName);
}
