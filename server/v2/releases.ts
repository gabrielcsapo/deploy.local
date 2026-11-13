import { observeReleaseParts } from './release-progress.ts';
import { recordTelemetryRelease } from '../telemetry-runtime.ts';
import { CopyWarmer, queueCopies } from '../packages/copies.ts';
import { npmRegistry } from '../packages/npm.ts';
import { agentControl } from './phone-preferences.ts';
import { projectReleasePolicy, retainProjectReleases } from './project-policy.ts';
import {
  assertNoApplicationMutations,
  clearInterruptedMutations,
  withinProjectRelease,
} from './releases-fence.ts';
import type { ShipChoices } from './releases-plan.ts';
import type {
  ApprovalRule,
  ApprovalAction,
  AgentApprovalAction,
  Project,
  Release,
  Rollback,
  RollbackDataLoss,
} from '../../shared/v2/contracts.ts';
import { db, event, get, id, list, now, save } from '../workspace/store.ts';
import { createInboxItem, registerInboxAction, withdrawInboxItems } from './inbox.ts';
import { fail } from '../kernel/errors.ts';

export interface ReleasePlan {
  apps: Release['apps'];
  migrations: Release['migrations'];
  source?: Pick<Release['source'], 'commit' | 'message' | 'gitRef'>;
  undo?: ReleasePlan[];
  // Adapter-owned immutable runtime receipts, never returned by the public API.
  runtime: unknown;
  verifyMigrations?: boolean;
}
export interface ReleaseBackup {
  id: string;
  capturedAt: string;
  apps: string[];
  runtime: unknown;
}
export interface ReleaseRuntime {
  plan(project: Project, ref?: string, choices?: ShipChoices): Promise<ReleasePlan>;
  prepare(plan: ReleasePlan): Promise<void>;
  verify(plan: ReleasePlan, backup?: ReleaseBackup): Promise<void>;
  backup(plan: ReleasePlan): Promise<ReleaseBackup>;
  activate(plan: ReleasePlan): Promise<void>;
  migrate(plan: ReleasePlan): Promise<void>;
  watch(plan: ReleasePlan, milliseconds: number): Promise<void>;
  rollback(from: ReleasePlan, to: ReleasePlan, backup?: ReleaseBackup): Promise<void>;
  dispose(plan: ReleasePlan): Promise<void>;
  fork?(plan: ReleasePlan): ReleasePlan;
  recover?(plan: ReleasePlan): Promise<'activated' | 'aborted'>;
}
type ReleaseRecord = {
  id: string;
  release: Release;
  project?: Project;
  plan?: ReleasePlan;
  backup?: ReleaseBackup;
  previousId?: string;
  activated?: boolean;
  recoveryRequired?: boolean;
  /** Only removing this release's copy failed; nothing on the computer was changed. */
  cleanupOwed?: boolean;
};
type RollbackRecord = {
  id: string;
  rollback: Rollback;
  state: 'running' | 'done' | 'failed';
  recoveryRequired?: boolean;
  dataLoss?: RollbackDataLoss;
  project?: Project;
  fromPlan?: ReleasePlan;
  targetPlan?: ReleasePlan;
  backup?: ReleaseBackup;
};
const steps = (): Release['steps'] =>
  ['prepare', 'verify', 'activate', 'watch'].map((name) => ({
    name: name as Release['steps'][number]['name'],
    state: 'waiting',
  }));

/** Current pointers, rather than release ordering, also describe failed activations and rollbacks. */
export function currentProjectReleases(owner: string) {
  return list('v2-project-current', owner).flatMap((pointer) =>
    [...new Set<string>([pointer.releaseId, ...(pointer.releaseIds || [])])].map((releaseId) => {
      const record: ReleaseRecord = get('v2-release', owner, releaseId);
      const activation = record.release.steps.find((step) => step.name === 'activate');
      return {
        ...record,
        releasedAt:
          (releaseId === pointer.releaseId ? pointer.releasedAt : undefined) ??
          activation?.endedAt ??
          activation?.startedAt,
      };
    }),
  );
}

export function projectReleases(owner: string, projectId: string): Release[] {
  return list('v2-release', owner)
    .map((row: ReleaseRecord) => row.release)
    .filter((release) => release.projectId === projectId)
    .reverse();
}
export function projectRollbacks(owner: string, projectId: string): Rollback[] {
  return list('v2-rollback', owner)
    .map((row: RollbackRecord) => row.rollback)
    .filter((rollback) => rollback.projectId === projectId)
    .reverse();
}
export function releaseById(owner: string, releaseId: string, projectId?: string): Release {
  const release: Release = get('v2-release', owner, releaseId).release;
  if (projectId && release.projectId !== projectId) fail('Release not found', 404);
  return release;
}
export const approvalActions: ApprovalAction[] = ['merge', 'rollback', 'restart'];

export function approvalRules(owner: string): ApprovalRule[] {
  return list('v2-approval', owner);
}
export function putApprovalRules(owner: string, rules: unknown): ApprovalRule[] {
  if (!Array.isArray(rules) || rules.length > 1000)
    fail('rules must be an array of at most 1000 rules');
  const ids = new Set<string>();
  const scopes = new Set<string>();
  for (const rule of rules) {
    if (
      !rule ||
      typeof rule.id !== 'string' ||
      !rule.id ||
      typeof rule.agent !== 'string' ||
      !rule.agent ||
      !approvalActions.includes(rule.action) ||
      !['ask', 'allow', 'never'].includes(rule.mode) ||
      (rule.projectId !== undefined && (typeof rule.projectId !== 'string' || !rule.projectId)) ||
      (rule.limit !== undefined && typeof rule.limit !== 'string')
    )
      fail('Invalid approval rule');
    if (
      rule.id.length > 200 ||
      rule.agent.length > 200 ||
      rule.projectId?.length > 200 ||
      rule.limit?.length > 2000
    )
      fail('Approval rule is too long');
    if (rule.action === 'ship' && rule.mode === 'allow') fail('Only you can start a release');
    const scope = JSON.stringify([rule.agent, rule.action, rule.projectId ?? null]);
    if (ids.has(rule.id) || scopes.has(scope)) fail('Duplicate approval rule');
    ids.add(rule.id);
    scopes.add(scope);
  }
  return db
    .transaction(() => {
      db.prepare("DELETE FROM records WHERE kind='v2-approval' AND owner=?").run(owner);
      for (const rule of rules) save('v2-approval', owner, rule);
      return approvalRules(owner);
    })
    .immediate();
}
export function approvalRule(
  owner: string,
  agent: string,
  action: ApprovalAction | AgentApprovalAction,
  projectId?: string,
): ApprovalRule | undefined {
  const rules = approvalRules(owner).filter(
    (rule) => rule.agent === agent && rule.action === action,
  );
  return (
    (projectId ? rules.find((rule) => rule.projectId === projectId) : undefined) ??
    rules.find((rule) => !rule.projectId)
  );
}

/** An allow authorizes unattended action only. Unknown free-text limits require a decision.
 * Call at execution admission, after resolving owner/project. Never overrides a person-only release.
 */
export function isAllowed(
  owner: string,
  agent: string,
  action: ApprovalAction | AgentApprovalAction,
  projectId?: string,
): boolean {
  if (agentControl(owner, agent).paused) return false;
  const rule = approvalRule(owner, agent, action, projectId);
  return (
    ['start-task', 'open-pull-request', 'merge', 'restart', 'rollback'].includes(action) &&
    rule?.mode === 'allow' &&
    !rule.limit?.trim()
  );
}
export function rollbackRule(owner: string, projectId: string) {
  return approvalRule(owner, 'warden', 'rollback', projectId);
}

function persistRelease(owner: string, record: ReleaseRecord) {
  const activation = record.release.steps.find((step) => step.name === 'activate');
  if (record.activated && activation?.startedAt) {
    for (const app of record.release.apps) {
      recordTelemetryRelease(app.appId, record.release.id, Date.parse(activation.startedAt));
    }
  }
  db.transaction(() => {
    save('v2-release', owner, record);
    event(owner, record.release.projectId, null, 'v2.release', { release: record.release });
  }).immediate();
}
function persistRollback(owner: string, record: RollbackRecord) {
  db.transaction(() => {
    save('v2-rollback', owner, record);
    event(owner, record.rollback.projectId, null, 'v2.rollback', { rollback: record.rollback });
  }).immediate();
}
export function assertProjectIdle(owner: string, projectId: string) {
  if (list('v2-project-run', owner).some((run) => run.id === projectId))
    fail('A release or rollback is already running for this project', 409);
}
function reserve(owner: string, project: Project, operationId: string) {
  assertProjectIdle(owner, project.id);
  if (list('v2-project-removal', owner).some((row) => row.id === project.id))
    fail('This project is being removed', 409);
  assertNoApplicationMutations(
    owner,
    project.apps.map((app) => app.id),
  );
  const apps = project.apps.map((app) => app.id);
  if (
    list('v2-project-run', owner).some((run) => run.apps.some((app: string) => apps.includes(app)))
  )
    fail('An app already belongs to a running release', 409);
  save('v2-project-run', owner, { id: project.id, operationId, apps, startedAt: now() });
}
function unlock(owner: string, projectId: string, operationId: string) {
  db.prepare(
    "DELETE FROM records WHERE kind='v2-project-run' AND owner=? AND id=? AND json_extract(data,'$.operationId')=?",
  ).run(owner, projectId, operationId);
}

export class ProjectReleaseService {
  readonly runtime: ReleaseRuntime;
  readonly watchMs: number;
  readonly pending = new Set<Promise<void>>();
  constructor(runtime: ReleaseRuntime, options: { watchMs?: number } = {}) {
    this.runtime = runtime;
    this.watchMs = options.watchMs ?? 600_000;
    if (!Number.isFinite(this.watchMs) || this.watchMs < 0)
      throw new Error('Invalid watch duration');
  }
  private launch(work: () => Promise<void>) {
    const promise = Promise.resolve().then(work);
    this.pending.add(promise);
    void promise
      .finally(() => this.pending.delete(promise))
      .catch((error) => console.error('[releases]', error));
  }
  async settled() {
    await Promise.all(this.pending);
  }

  private cleaning = false;
  /**
   * A release that failed before Verify finished changed nothing on its computers; it only owes
   * the removal of its own copy. When that removal failed too (the computer's Docker was down),
   * try it again here, so the project does not stay locked until the coordinator restarts.
   */
  async retryCleanup() {
    if (this.cleaning) return;
    this.cleaning = true;
    try {
      const reservations = db
        .prepare("SELECT owner,data FROM records WHERE kind='v2-project-run'")
        .all() as { owner: string; data: string }[];
      for (const reservation of reservations) {
        const run = JSON.parse(reservation.data);
        const record = list('v2-release', reservation.owner).find(
          (row) => row.id === run.operationId,
        ) as ReleaseRecord | undefined;
        if (!record?.plan || !record.recoveryRequired || record.release.state !== 'failed')
          continue;
        const taken = record.release.steps;
        if (taken.find((step) => step.name === 'verify')?.state === 'done') continue;
        // Records written before cleanupOwed existed carry only the message, on whichever step
        // failed: the run's own cleanup, or the recovery after a coordinator restart.
        if (
          !record.cleanupOwed &&
          !taken.some(
            (step) =>
              step.detail?.startsWith('Cleanup requires recovery') ||
              step.detail?.startsWith('Recovery: '),
          )
        )
          continue;
        try {
          await this.runtime.dispose(record.plan);
        } catch {
          continue;
        }
        record.recoveryRequired = false;
        record.cleanupOwed = false;
        persistRelease(reservation.owner, record);
        unlock(reservation.owner, run.id, run.operationId);
        console.log(`[releases] cleaned up failed release ${record.id}; project unlocked`);
      }
    } finally {
      this.cleaning = false;
    }
  }

  /** Called once at coordinator startup, before admitting new project work. */
  async recover() {
    clearInterruptedMutations();
    const reservations = db
      .prepare("SELECT owner,data FROM records WHERE kind='v2-project-run'")
      .all() as { owner: string; data: string }[];
    for (const reservation of reservations) {
      const owner = reservation.owner;
      const run = JSON.parse(reservation.data);
      const release = list('v2-release', owner).find((row) => row.id === run.operationId) as
        | ReleaseRecord
        | undefined;
      if (release) {
        const activation = release.release.steps.find((step) => step.name === 'activate')!;
        try {
          if (!release.project) fail('Recovery requires the saved project membership', 409);
          if (release.release.steps.find((step) => step.name === 'verify')?.state !== 'done') {
            if (release.plan)
              try {
                await this.runtime.dispose(release.plan);
              } catch (error) {
                // The computer could not be reached now. Nothing but the release's own copy
                // is left to remove, so the minute-by-minute cleanup may finish this later.
                release.cleanupOwed = true;
                throw error;
              }
            throw Object.assign(
              new Error('Coordinator restarted before Verify completed; original project retained'),
              { safeToUnlock: true },
            );
          }
          if (activation.state === 'running' || release.recoveryRequired) {
            if (!release.plan || !this.runtime.recover)
              fail('Runtime recovery is unavailable', 409);
            const result = await withinProjectRelease(run.operationId, () =>
              this.runtime.recover!(release.plan!),
            );
            if (result === 'aborted')
              throw Object.assign(
                new Error('Coordinator restarted during activation; restored every previous app'),
                { safeToUnlock: true },
              );
            release.activated = true;
          }
          activation.detail =
            'Recovered after coordinator restart; completing the verified project';
          release.recoveryRequired = false;
          release.release.state = 'running';
          persistRelease(owner, release);
          await withinProjectRelease(release.id, () =>
            this.runRelease(owner, release.project!, release),
          );
        } catch (error) {
          const uncertain = !(error as any).safeToUnlock;
          const step =
            release.release.steps.find((entry) => entry.state === 'running') || activation;
          step.state = 'failed';
          step.endedAt = now();
          step.detail = `Recovery: ${error instanceof Error ? error.message : String(error)}`;
          release.release.state = 'failed';
          release.recoveryRequired = !!uncertain;
          for (const waiting of release.release.steps.filter((entry) => entry.state === 'waiting'))
            waiting.state = 'skipped';
          persistRelease(owner, release);
          if (!uncertain) unlock(owner, run.id, run.operationId);
        }
        continue;
      }
      const record = list('v2-rollback', owner).find((row) => row.id === run.operationId) as
        | RollbackRecord
        | undefined;
      if (!record) continue;
      try {
        const current: ReleaseRecord = get('v2-release', owner, record.rollback.from);
        const target: ReleaseRecord = get('v2-release', owner, record.rollback.to);
        const activation = record.rollback.steps.find((step) => step.name === 'activate')!;
        if (!record.project || !record.targetPlan || !record.fromPlan)
          fail('Rollback recovery receipts are unavailable', 409);
        if (record.rollback.steps.find((step) => step.name === 'verify')?.state !== 'done') {
          await this.runtime.dispose(record.targetPlan);
          throw Object.assign(
            new Error(
              'Coordinator restarted before rollback Verify completed; original project retained',
            ),
            { safeToUnlock: true },
          );
        }
        if (activation.state === 'running') {
          if (!this.runtime.recover) fail('Runtime recovery is unavailable', 409);
          if (
            (await withinProjectRelease(run.operationId, () =>
              this.runtime.recover!(record.targetPlan!),
            )) === 'aborted'
          )
            throw Object.assign(
              new Error('Coordinator restarted during rollback; restored every previous app'),
              { safeToUnlock: true },
            );
        } else if (activation.state !== 'done')
          await withinProjectRelease(run.operationId, () =>
            this.runtime.rollback(record.fromPlan!, record.targetPlan!, record.backup),
          );
        activation.state = 'done';
        activation.detail = 'Recovered verified rollback after coordinator restart';
        activation.endedAt = now();
        db.transaction(() => {
          current.release.state = 'rolled-back';
          target.release.state = 'live';
          save('v2-project-current', owner, {
            id: run.id,
            releaseId: target.id,
            releasedAt: now(),
          });
          persistRelease(owner, current);
          persistRelease(owner, target);
          persistRollback(owner, record);
        }).immediate();
        await withinProjectRelease(run.operationId, () =>
          this.runtime.watch(record.targetPlan!, this.watchMs),
        );
        record.rollback.steps.find((step) => step.name === 'watch')!.state = 'done';
        record.state = 'done';
        record.recoveryRequired = false;
      } catch (error) {
        record.state = 'failed';
        record.recoveryRequired = !(error as any).safeToUnlock;
        const step =
          record.rollback.steps.find((entry) => entry.state === 'running') ||
          record.rollback.steps.find((entry) => entry.name === 'activate')!;
        step.state = 'failed';
        step.detail = `Recovery: ${error instanceof Error ? error.message : String(error)}`;
        step.endedAt = now();
      }
      persistRollback(owner, record);
      if (!record.recoveryRequired) unlock(owner, run.id, run.operationId);
    }
  }

  ship(owner: string, project: Project, body: any): Release {
    if (
      !body ||
      !body.source ||
      !['pr', 'ship', 'cli', 'pipeline'].includes(body.source.kind) ||
      typeof body.source.ref !== 'string' ||
      !body.source.ref.trim() ||
      body.source.ref.length > 500 ||
      (body.ref !== undefined &&
        (typeof body.ref !== 'string' || !body.ref || body.ref.length > 200))
    )
      fail('Release source and optional ref required');
    if (!project.apps.length) fail('This project has no apps to release', 409);
    const release: Release = {
      id: id(),
      projectId: project.id,
      source: { kind: body.source.kind, ref: body.source.ref },
      startedBy: owner,
      apps: [],
      migrations: [],
      steps: steps(),
      state: 'running',
    };
    const record: ReleaseRecord = { id: release.id, release, project: structuredClone(project) };
    db.transaction(() => {
      reserve(owner, project, release.id);
      persistRelease(owner, record);
    }).immediate();
    this.launch(() =>
      withinProjectRelease(record.id, () =>
        this.runRelease(owner, project, record, body.ref, body.choices),
      ),
    );
    return structuredClone(release);
  }
  private async runRelease(
    owner: string,
    project: Project,
    record: ReleaseRecord,
    ref?: string,
    choices?: ShipChoices,
  ) {
    const release = record.release;
    try {
      for (const step of release.steps) {
        if (step.state === 'done') continue;
        step.state = 'running';
        step.startedAt = now();
        persistRelease(owner, record);
        if (record.plan)
          observeReleaseParts(record.plan, step, () => persistRelease(owner, record));
        if (step.name === 'prepare') {
          record.plan = await this.runtime.plan(project, ref, choices);
          record.plan.verifyMigrations = projectReleasePolicy(owner, project.id).verifyMigrations;
          if (
            record.plan.apps.length !== project.apps.length ||
            new Set(record.plan.apps.map((app) => app.appId)).size !== project.apps.length ||
            project.apps.some((app) => !record.plan!.apps.some((entry) => entry.appId === app.id))
          )
            fail('Release plan must contain every app exactly once');
          release.source = { ...release.source, ...record.plan.source };
          release.apps = record.plan.apps;
          release.migrations = record.plan.migrations;
          persistRelease(owner, record);
          const repository = list('project', owner).find((p) => p.id === project.id);
          if (repository?.repositoryPath && release.source.commit) {
            await new CopyWarmer(npmRegistry.copy)
              .scan(owner, repository, release.source.commit, record.id, 'release', false)
              .catch(() => queueCopies(owner, project.id));
          }
          observeReleaseParts(record.plan, step, () => persistRelease(owner, record));
          await this.runtime.prepare(record.plan);
        } else if (step.name === 'verify') await this.runtime.verify(record.plan!);
        else if (step.name === 'activate') {
          if (!record.backup && release.migrations.some((migration) => !migration.reversible)) {
            record.backup = await this.runtime.backup(record.plan!);
            if (project.apps.some((app) => !record.backup!.apps.includes(app.id)))
              fail('Pre-release backup must cover every app');
            release.backupId = record.backup.id;
            persistRelease(owner, record);
          }
          if (!record.activated) {
            record.previousId = list('v2-project-current', owner).find(
              (row) => row.id === project.id,
            )?.releaseId;
            persistRelease(owner, record);
            await this.runtime.activate(record.plan!);
          }
          db.transaction(() => {
            const pointer = list('v2-project-current', owner).find((row) => row.id === project.id);
            if (pointer?.releaseId !== release.id) record.previousId = pointer?.releaseId;
            record.activated = true;
            if (pointer && pointer.releaseId !== release.id) {
              const previous: ReleaseRecord = get('v2-release', owner, pointer.releaseId);
              previous.release.state = 'superseded';
              persistRelease(owner, previous);
            }
            withdrawInboxItems(owner, project.id, 'rollback');
            save('v2-project-current', owner, {
              id: project.id,
              releaseId: release.id,
              releasedAt: now(),
            });
            persistRelease(owner, record);
          }).immediate();
          await this.runtime.migrate(record.plan!);
        } else await this.runtime.watch(record.plan!, this.watchMs);
        step.state = 'done';
        step.endedAt = now();
        persistRelease(owner, record);
      }
      db.transaction(() => {
        for (const previous of list('v2-release', owner) as ReleaseRecord[]) {
          if (previous.release.projectId === project.id && previous.release.state === 'live') {
            previous.release.state = 'superseded';
            persistRelease(owner, previous);
          }
        }
        release.state = 'live';
        queueCopies(owner, project.id);
        persistRelease(owner, record);
        retainProjectReleases(owner, project.id);
      }).immediate();
    } catch (error) {
      record.recoveryRequired = !!(error as { requiresRecovery?: boolean })?.requiresRecovery;
      const step = release.steps.find((entry) => entry.state === 'running')!;
      step.state = 'failed';
      step.endedAt = now();
      step.detail = error instanceof Error ? error.message : String(error);
      for (const waiting of release.steps.filter((entry) => entry.state === 'waiting'))
        waiting.state = 'skipped';
      if (record.recoveryRequired) step.detail += ' Project remains locked for recovery.';
      // A computer that was too slow to answer during Prepare or Verify has changed nothing
      // that is live. It only owes the removal of its copy, which waits behind the slow job
      // on that computer, so the retry can unlock the project without a coordinator restart.
      if (record.recoveryRequired && (step.name === 'prepare' || step.name === 'verify'))
        record.cleanupOwed = true;
      release.state = 'failed';
      persistRelease(owner, record);
    } finally {
      try {
        if (record.plan && !record.recoveryRequired) await this.runtime.dispose(record.plan);
      } catch (error) {
        record.recoveryRequired = true;
        record.cleanupOwed = true;
        release.state = 'failed';
        release.steps.at(-1)!.detail =
          `Cleanup requires recovery: ${error instanceof Error ? error.message : String(error)}`;
        persistRelease(owner, record);
      } finally {
        if (!record.recoveryRequired) unlock(owner, project.id, release.id);
      }
    }
    if (release.state === 'failed' && record.activated && record.previousId) {
      try {
        this.requestAutoRollback(
          owner,
          project,
          release.steps.find((step) => step.state === 'failed')?.detail || 'Release health failed',
        );
      } catch (error) {
        console.error('[releases] Could not request rollback', error);
      }
    }
  }

  rollback(
    owner: string,
    project: Project,
    body: any,
    approvedBy: string = owner,
    ruleId?: string,
  ): { rollback: Rollback; dataLoss?: RollbackDataLoss } {
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      ['from', 'to', 'reason'].some(
        (key) =>
          body[key] !== undefined && (typeof body[key] !== 'string' || body[key].length > 4000),
      )
    )
      fail('Invalid rollback request');
    if (approvedBy === 'rule') {
      const rule = rollbackRule(owner, project.id);
      if (!rule || rule.id !== ruleId || !isAllowed(owner, 'warden', 'rollback', project.id))
        fail('An explicit rollback allow rule is required', 403);
    } else if (approvedBy !== owner)
      fail('Rollback approval must belong to the signed-in person', 403);
    return db
      .transaction(() => {
        assertProjectIdle(owner, project.id);
        const records = (list('v2-release', owner) as ReleaseRecord[]).filter(
          (row) => row.release.projectId === project.id,
        );
        const pointer = list('v2-project-current', owner).find((row) => row.id === project.id);
        const current = records.find((row) => row.id === pointer?.releaseId);
        if (!current || (body.from && body.from !== current.id))
          fail('The current release changed; refresh before rolling back', 409);
        const target = body.to
          ? records.find((row) => row.id === body.to)
          : records.find((row) => row.id === current.previousId);
        if (
          !target ||
          target.id === current.id ||
          !['superseded', 'rolled-back'].includes(target.release.state) ||
          !target.plan ||
          !current.plan
        )
          fail('A complete prior release is required', 409);
        if (
          project.apps.length !== target.plan.apps.length ||
          project.apps.some((app) => !target.plan!.apps.some((entry) => entry.appId === app.id))
        )
          fail('Target release has different apps', 409);
        // Follow actual activation ancestry; failed attempts and abandoned branches are not migrations.
        const crossed: ReleaseRecord[] = [];
        let ancestor: ReleaseRecord | undefined = current;
        while (ancestor && ancestor.id !== target.id) {
          crossed.push(ancestor);
          ancestor = records.find((row) => row.id === ancestor!.previousId);
        }
        if (!ancestor) fail('Target is not an ancestor of the current release', 409);
        crossed.reverse();
        const irreversible = crossed.find((row) =>
          row.release.migrations.some((migration) => !migration.reversible),
        );
        const backup = irreversible?.backup;
        let dataLoss: RollbackDataLoss | undefined;
        if (irreversible) {
          if (!backup) fail('Required pre-release backup is missing; rollback refused', 409);
          dataLoss = {
            backupId: backup.id,
            capturedAt: backup.capturedAt,
            apps: backup.apps,
            summary: `Restoring ${backup.id} discards all data written after ${backup.capturedAt} in ${backup.apps.join(', ')}.`,
          };
          // A plain rollback call is a review request. The backup id binds consent to exact data loss.
          if (approvedBy === 'rule' || body.confirmBackupId !== backup.id)
            throw Object.assign(
              new Error('Review and confirm the pre-release backup before restoring data'),
              { status: 409, dataLoss },
            );
        }
        const rollback: Rollback = {
          id: id(),
          projectId: project.id,
          from: current.id,
          to: target.id,
          reason: body.reason || 'Requested rollback',
          approvedBy,
          ...(ruleId ? { ruleId } : {}),
          steps: steps(),
        };
        const record: RollbackRecord = {
          id: rollback.id,
          rollback,
          state: 'running',
          project: structuredClone(project),
          targetPlan: this.runtime.fork?.(target.plan) ?? structuredClone(target.plan),
          fromPlan: {
            ...current.plan!,
            undo: (irreversible ? crossed.slice(0, crossed.indexOf(irreversible)) : crossed)
              .slice()
              .reverse()
              .map((row) => ({ ...row.plan!, migrations: [...row.release.migrations].reverse() })),
            migrations: (irreversible ? crossed.slice(0, crossed.indexOf(irreversible)) : crossed)
              .flatMap((row) => row.release.migrations)
              .reverse(),
          },
          backup,
          ...(dataLoss ? { dataLoss } : {}),
        };
        withdrawInboxItems(owner, project.id, 'rollback');
        reserve(owner, project, rollback.id);
        persistRollback(owner, record);
        this.launch(() =>
          withinProjectRelease(record.id, async () => {
            try {
              for (const step of rollback.steps) {
                step.state = 'running';
                step.startedAt = now();
                persistRollback(owner, record);
                observeReleaseParts([record.targetPlan!, record.fromPlan!], step, () =>
                  persistRollback(owner, record),
                );
                if (step.name === 'prepare') await this.runtime.prepare(record.targetPlan!);
                if (step.name === 'verify') await this.runtime.verify(record.targetPlan!, backup);
                if (step.name === 'activate') {
                  await this.runtime.rollback(record.fromPlan!, record.targetPlan!, backup);
                  db.transaction(() => {
                    current.release.state = 'rolled-back';
                    target.release.state = 'live';
                    save('v2-project-current', owner, {
                      id: project.id,
                      releaseId: target.id,
                      releasedAt: now(),
                    });
                    persistRelease(owner, current);
                    persistRelease(owner, target);
                  }).immediate();
                }
                if (step.name === 'watch')
                  await this.runtime.watch(record.targetPlan!, this.watchMs);
                step.state = 'done';
                step.endedAt = now();
                persistRollback(owner, record);
              }
              db.transaction(() => {
                current.release.state = 'rolled-back';
                target.release.state = 'live';
                persistRelease(owner, current);
                persistRelease(owner, target);
                record.state = 'done';
                persistRollback(owner, record);
              }).immediate();
            } catch (error) {
              record.recoveryRequired = !!(error as { requiresRecovery?: boolean })
                ?.requiresRecovery;
              const step = rollback.steps.find((entry) => entry.state === 'running')!;
              step.state = 'failed';
              step.endedAt = now();
              step.detail = error instanceof Error ? error.message : String(error);
              for (const entry of rollback.steps.filter((entry) => entry.state === 'waiting'))
                entry.state = 'skipped';
              if (record.recoveryRequired) step.detail += ' Project remains locked for recovery.';
              record.state = 'failed';
              persistRollback(owner, record);
            } finally {
              try {
                await this.runtime.dispose(target.plan!);
              } finally {
                if (!record.recoveryRequired) unlock(owner, project.id, rollback.id);
              }
            }
          }),
        );
        return { rollback: structuredClone(rollback), ...(dataLoss ? { dataLoss } : {}) };
      })
      .immediate();
  }

  requestAutoRollback(owner: string, project: Project, reason: string) {
    if (agentControl(owner, 'warden').paused) return { allowed: false };
    const rule = rollbackRule(owner, project.id);
    if (rule?.mode === 'never') return { allowed: false };
    if (rule && isAllowed(owner, 'warden', 'rollback', project.id)) {
      try {
        return this.rollback(owner, project, { reason }, 'rule', rule.id);
      } catch (error: any) {
        if (!error.dataLoss) throw error;
      }
    }
    const pointer = list('v2-project-current', owner).find((row) => row.id === project.id);
    const current = pointer ? releaseById(owner, pointer.releaseId) : undefined;
    if (!current) fail('No current release to roll back', 409);
    return {
      item: createInboxItem(
        owner,
        {
          id: `rollback:${project.id}:${current.id}`,
          kind: 'rollback',
          title: `Roll back ${project.name}?`,
          text: reason,
          from: 'warden',
          projectId: project.id,
          createdAt: now(),
          state: 'waiting',
          actions: [
            { id: 'rollback', label: 'Roll back', primary: true },
            { id: 'keep', label: 'Keep release' },
          ],
        },
        { project, from: current.id },
      ),
    };
  }
  registerInbox() {
    return registerInboxAction('rollback', (owner, item, body, context) => {
      if (rollbackRule(owner, context.project.id)?.mode === 'never')
        fail('Rollback is forbidden by an Approvals rule', 403);
      if (body.actionId !== 'rollback') fail('Unknown rollback action', 501);
      this.rollback(owner, context.project, {
        from: context.from,
        reason: item.text,
        confirmBackupId: body.confirmBackupId,
      });
    });
  }
}

export function assertApplicationReleaseIdle(owner: string, application: string) {
  if (list('v2-project-run', owner).some((run) => run.apps.includes(application)))
    fail('A project release or rollback is already running', 409);
}
