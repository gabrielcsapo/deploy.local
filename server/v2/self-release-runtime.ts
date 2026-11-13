import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Project } from '../../shared/v2/contracts.ts';
import { deployDataDirectory } from '../kernel/files/data-directory.ts';
import { isAdmin, readDeploymentRecord } from '../store.ts';
import { save } from '../workspace/store.ts';
import { CoordinatorReleaseRuntime } from './releases-runtime.ts';
import {
  coordinatorCommand,
  readCoordinatorManifest,
  settledCoordinatorReceipt,
} from './coordinator-executor.ts';
import type { ReleaseBackup, ReleasePlan } from './releases.ts';
import type { ShipChoices } from './releases-plan.ts';

type SelfPlan = {
  kind: 'coordinator-self-release';
  id: string;
  version: string;
  source: string;
  digest: string;
};
function self(plan: ReleasePlan): SelfPlan | undefined {
  return (plan.runtime as SelfPlan)?.kind === 'coordinator-self-release'
    ? (plan.runtime as SelfPlan)
    : undefined;
}
export const COORDINATOR_UNAVAILABLE =
  'Coordinator updates need a verified build bundle and an isolated data-copy check. This installed build does not provide them yet.';

/** Container releases keep their existing adapter; the host coordinator uses its external executor. */
export class SelfReleaseRuntime extends CoordinatorReleaseRuntime {
  override async plan(project: Project, ref?: string, choices?: ShipChoices) {
    if (!project.apps.some((app) => app.name === 'deploy.local'))
      return super.plan(project, ref, choices);
    if (project.apps.length !== 1)
      throw new Error('The coordinator must be released separately from other apps.');
    const deployment = readDeploymentRecord('deploy.local');
    if (deployment && !isAdmin(deployment.username))
      throw new Error('Only an administrator can release the coordinator.');
    const source = deployment?.directory;
    if (
      !source ||
      !existsSync(join(source, 'coordinator-build.json')) ||
      !existsSync(join(deployDataDirectory(), 'coordinator-updates', 'switch.sock'))
    )
      throw new Error(COORDINATOR_UNAVAILABLE);
    const { manifest, digest } = readCoordinatorManifest(source);
    if (ref && ref !== manifest.version)
      throw new Error(
        'Ship the verified coordinator build version; an unbuilt repository ref cannot switch the coordinator.',
      );
    const runtime: SelfPlan = {
      kind: 'coordinator-self-release',
      id: randomUUID(),
      version: manifest.version,
      source,
      digest,
    };
    return { apps: [{ appId: project.apps[0].id, to: manifest.version }], migrations: [], runtime };
  }
  override fork(plan: ReleasePlan) {
    const runtime = self(plan);
    if (!runtime) return super.fork(plan);
    return {
      ...structuredClone(plan),
      runtime: {
        ...runtime,
        id: randomUUID(),
        source: join(deployDataDirectory(), 'coordinator-updates', 'builds', runtime.id),
      },
    };
  }
  override async prepare(plan: ReleasePlan) {
    const runtime = self(plan);
    if (!runtime) return super.prepare(plan);
    await coordinatorCommand(deployDataDirectory(), 'prepare', runtime);
  }
  override async verify(plan: ReleasePlan, backup?: ReleaseBackup) {
    const runtime = self(plan);
    if (!runtime) return super.verify(plan, backup);
    if (backup || plan.migrations.length)
      throw new Error('Coordinator data migrations are not supported by this switch protocol.');
    await this.prepare(plan);
    await coordinatorCommand(deployDataDirectory(), 'verify', { id: runtime.id });
  }
  override async activate(plan: ReleasePlan) {
    const runtime = self(plan);
    if (!runtime) return super.activate(plan);
    try {
      const receipt = await coordinatorCommand(deployDataDirectory(), 'activate', {
        id: runtime.id,
      });
      if (receipt.state !== 'activated')
        throw new Error(receipt.error || 'The previous coordinator was restored.');
      save('v2-coordinator-activation', 'system', {
        id: runtime.id,
        state: receipt.state,
        version: runtime.version,
      });
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        requiresRecovery: true,
      });
    }
  }
  override async recover(plan: ReleasePlan): Promise<'activated' | 'aborted'> {
    const runtime = self(plan);
    if (!runtime) return super.recover(plan);
    const receipt = await settledCoordinatorReceipt(deployDataDirectory(), runtime.id);
    if (!['activated', 'aborted'].includes(receipt.state))
      throw new Error('Coordinator activation receipt is incomplete.');
    save('v2-coordinator-activation', 'system', {
      id: runtime.id,
      state: receipt.state,
      version: runtime.version,
    });
    return receipt.state as 'activated' | 'aborted';
  }
  override async migrate(plan: ReleasePlan) {
    if (!self(plan)) await super.migrate(plan);
  }
  override async watch(plan: ReleasePlan, milliseconds: number) {
    const runtime = self(plan);
    if (!runtime) return super.watch(plan, milliseconds);
    const end = Date.now() + milliseconds;
    do {
      const receipt = await coordinatorCommand(deployDataDirectory(), 'status', { id: runtime.id });
      if (receipt.state !== 'activated' || process.env.DEPLOY_COORDINATOR_RELEASE !== runtime.id)
        throw new Error('The coordinator no longer matches this release.');
      await delay(Math.min(1000, Math.max(0, end - Date.now())));
    } while (Date.now() < end);
  }
  override async rollback(from: ReleasePlan, to: ReleasePlan, backup?: ReleaseBackup) {
    if (!self(from) && !self(to)) return super.rollback(from, to, backup);
    if (!self(from) || !self(to) || backup)
      throw new Error('Coordinator rollback requires compatible verified coordinator builds.');
    await this.activate(to);
  }
  override async dispose(plan: ReleasePlan) {
    if (!self(plan)) await super.dispose(plan);
  }
  override async backup(plan: ReleasePlan): Promise<ReleaseBackup> {
    if (!self(plan)) return super.backup(plan);
    throw new Error('Coordinator data migrations must remain disabled.');
  }
}
