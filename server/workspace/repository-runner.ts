import { executePullMerge } from './project-collaboration.ts';
import { recordCheckpointBase } from './checkpoint.ts';
import { initializeScratchWorkspace } from './scratch.ts';
import { hydrateLfs } from './lfs-checkout.ts';
import { list, event } from './store.ts';
import { mkdir, rename, rm, access, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root, db, get, save, now } from './store.ts';
import { gitText as runGitText } from './repository-git.ts';
import { repositorySource } from './repositories.ts';

const exists = async (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
export class RepositoryRunner {
  private active?: { owner: string; operationId: string; controller: AbortController };
  private stopping = false;
  recover() {
    // An interrupted import/fetch is never silently replayed. Retry is an explicit command.
    for (const row of db
      .prepare("SELECT owner,data FROM records WHERE kind='repository-operation'")
      .all() as any[]) {
      const operation = JSON.parse(row.data);
      if (operation.status === 'running')
        this.finish(
          row.owner,
          operation,
          'unknown',
          'Repository service restarted; inspect and retry the operation',
        );
    }
  }
  stop() {
    this.stopping = true;
    this.active?.controller.abort();
  }
  async tick() {
    if (this.active) {
      const operation = get('repository-operation', this.active.owner, this.active.operationId);
      if (operation.cancelRequested) this.active.controller.abort();
      return;
    }
    if (this.stopping) return;
    const assignment = db
      .transaction(() => {
        for (const row of db
          .prepare(
            "SELECT owner,data FROM records WHERE kind='repository-operation' ORDER BY rowid",
          )
          .all() as any[]) {
          const operation = JSON.parse(row.data);
          if (operation.status !== 'queued') continue;
          if (operation.cancelRequested) {
            this.finish(row.owner, operation, 'cancelled');
            continue;
          }
          save('repository-operation', row.owner, {
            ...operation,
            status: 'running',
            startedAt: now(),
            updatedAt: now(),
          });
          return { owner: row.owner, operation };
        }
      })
      .immediate();
    if (!assignment) return;
    const { owner, operation } = assignment;
    const controller = new AbortController();
    this.active = { owner, operationId: operation.id, controller };
    const stageRoot = resolve(root, 'repository-staging', operation.id);
    try {
      if (operation.kind === 'pull-merge') {
        await executePullMerge(owner, operation, (cwd, args, options) =>
          this.gitText(cwd, args, { ...options, signal: controller.signal }),
        );
        this.finish(owner, operation, 'succeeded');
        return;
      }
      if (operation.kind === 'workspace') {
        await this.prepareTask(owner, operation, controller.signal);
        this.finish(owner, operation, 'succeeded');
        return;
      }
      const project = get('project', owner, operation.projectId);
      if (project.repositoryOperationId !== operation.id)
        throw new Error('Repository operation was superseded');
      if (operation.kind === 'prepare') await this.prepare(project, stageRoot, controller.signal);
      else {
        const source = repositorySource(project.sourcePath);
        if (!source.location) throw new Error('Repository has no upstream source');
        await this.gitText(
          project.repositoryPath,
          [
            'fetch',
            '--atomic',
            '--no-tags',
            '--no-write-fetch-head',
            source.location,
            '+refs/heads/*:refs/remotes/upstream/*',
          ],
          { signal: controller.signal, timeout: 600000 },
        );
      }
      const defaultBranch = await this.gitText(project.repositoryPath, [
        'symbolic-ref',
        '--short',
        'HEAD',
      ]);
      const head = await this.gitText(project.repositoryPath, ['rev-parse', '--verify', 'HEAD']);
      db.transaction(() => {
        const current = get('project', owner, project.id);
        if (current.repositoryOperationId !== operation.id)
          throw new Error('Repository operation was superseded');
        save('project', owner, {
          ...current,
          repositoryStatus: 'ready',
          defaultBranch,
          head,
          updatedAt: now(),
        });
        this.finish(owner, operation, 'succeeded');
      })();
    } catch (error: any) {
      this.finish(
        owner,
        operation,
        controller.signal.aborted ? 'cancelled' : 'failed',
        String(error.message).slice(0, 8000),
      );
    } finally {
      await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
      this.active = undefined;
    }
  }
  private gitText(cwd: string, args: string[], options: Parameters<typeof runGitText>[2] = {}) {
    const active = this.active;
    return runGitText(cwd, args, {
      ...options,
      onProcess: (pid) => {
        if (!active) return;
        const current = get('repository-operation', active.owner, active.operationId);
        save('repository-operation', active.owner, { ...current, gitPid: pid });
      },
    });
  }
  private async prepareTask(owner: string, operation: any, signal: AbortSignal) {
    const task = get('task', owner, operation.taskId);
    if (task.workspaceOperationId !== operation.id)
      throw new Error('Workspace operation was superseded');
    const marker = resolve(root, 'workspace-ready', task.id + '.json');
    if (await exists(task.workspacePath)) {
      const proof = await readFile(marker, 'utf8')
        .then(JSON.parse)
        .catch(() => null);
      if (proof?.taskId !== task.id)
        throw new Error(
          'Partial workspace exists; inspect its files before creating a replacement task',
        );
      const head = await this.gitText(task.workspacePath, ['rev-parse', 'HEAD'], { signal });
      if (head !== proof.baseRevision)
        throw new Error('Workspace changed after preparation; inspect it before recovery');
    } else if (task.projectId) {
      const project = get('project', owner, task.projectId);
      await mkdir(resolve(root, 'tasks'), { recursive: true });
      await this.gitText(
        project.repositoryPath,
        ['worktree', 'add', '-b', `task/${task.id}`, task.workspacePath, task.baseRevision],
        { signal, timeout: 600000 },
      );
    } else {
      initializeScratchWorkspace(task.workspacePath);
    }
    const baseRevision = await this.gitText(task.workspacePath, ['rev-parse', 'HEAD'], { signal });
    if (task.projectId) {
      // Checkpoints in a repository workspace are a delta over the commit it was prepared from.
      recordCheckpointBase(task.workspacePath, baseRevision);
      await hydrateLfs(task.workspacePath, get('project', owner, task.projectId).repositoryPath, {
        signal,
        timeout: 600000,
      });
    }
    await mkdir(resolve(root, 'workspace-ready'), { recursive: true });
    await writeFile(marker, JSON.stringify({ taskId: task.id, baseRevision }), { mode: 0o600 });
    db.transaction(() => {
      const current = get('task', owner, task.id);
      const queued = list('run', owner).some(
        (run) => run.taskId === task.id && run.status === 'queued',
      );
      const ready = save('task', owner, {
        ...current,
        workspaceStatus: 'ready',
        baseRevision,
        status: queued ? 'running' : 'ready',
        updatedAt: now(),
      });
      event(owner, task.id, null, 'task.prepared', ready);
    }).immediate();
  }
  private finish(owner: string, operation: any, status: string, error?: string) {
    save('repository-operation', owner, {
      ...get('repository-operation', owner, operation.id),
      status,
      error: error || null,
      updatedAt: now(),
      completedAt: now(),
    });
    if (operation.kind === 'workspace' && status !== 'succeeded') {
      const task = get('task', owner, operation.taskId);
      if (task.workspaceOperationId === operation.id)
        save('task', owner, {
          ...task,
          workspaceStatus: status === 'unknown' ? 'unknown' : 'failed',
          status: 'blocked',
          updatedAt: now(),
        });
    }
    if (operation.kind === 'prepare' && status !== 'succeeded') {
      const project = get('project', owner, operation.projectId);
      if (project.repositoryOperationId === operation.id)
        save('project', owner, {
          ...project,
          repositoryStatus: status === 'unknown' ? 'unknown' : 'failed',
          updatedAt: now(),
        });
    }
  }
  private async prepare(project: any, stageRoot: string, signal: AbortSignal) {
    if (await exists(project.repositoryPath)) {
      // A crash can occur between the atomic rename and metadata commit. Adopt only our own completed repository.
      if (
        (await this.gitText(project.repositoryPath, ['config', '--get', 'deploy.projectId'])) !==
        project.id
      )
        throw new Error('Repository path is already occupied');
      await this.gitText(project.repositoryPath, ['rev-parse', '--verify', 'HEAD']);
      return;
    }
    const stage = resolve(stageRoot, 'repository.git');
    await mkdir(stageRoot, { recursive: true });
    const source = repositorySource(project.sourcePath);
    if (source.location)
      await this.gitText(
        stageRoot,
        ['clone', '--bare', '--no-local', '--template=', '--', source.location, stage],
        { signal, timeout: 600000 },
      );
    else {
      await mkdir(stage);
      await this.gitText(stage, ['init', '--bare', '--template=', '--initial-branch=main'], {
        signal,
      });
    }
    const branches = (
      await this.gitText(stage, ['for-each-ref', '--format=%(refname)', 'refs/heads'], { signal })
    )
      .split('\n')
      .filter(Boolean);
    if (branches.length === 0) {
      // Empty upstreams are valid projects; initialize a deterministic default branch without touching the source.
      const seed = resolve(stageRoot, 'seed');
      await mkdir(seed);
      await this.gitText(seed, ['init', '--template=', '--initial-branch=main'], { signal });
      await this.gitText(
        seed,
        [
          '-c',
          'user.name=deploy.local',
          '-c',
          'user.email=workspace@deploy.local',
          'commit',
          '--allow-empty',
          '-m',
          'Initialize project',
        ],
        { signal },
      );
      await this.gitText(seed, ['push', stage, 'HEAD:main'], { signal });
      await this.gitText(stage, ['symbolic-ref', 'HEAD', 'refs/heads/main'], { signal });
    } else {
      const head = await this.gitText(stage, ['symbolic-ref', 'HEAD'], { signal }).catch(() => '');
      if (!branches.includes(head))
        await this.gitText(stage, ['symbolic-ref', 'HEAD', branches[0]], { signal });
    }
    // Imported origin is provenance, never an implicit write destination.
    if (source.location) await this.gitText(stage, ['remote', 'remove', 'origin'], { signal });
    await this.gitText(stage, ['config', 'http.receivepack', 'true'], { signal });
    await this.gitText(stage, ['config', 'core.hooksPath', '/dev/null'], { signal });
    await this.gitText(stage, ['config', 'deploy.projectId', project.id], { signal });
    await this.gitText(stage, ['rev-parse', '--verify', 'HEAD'], { signal });
    if (signal.aborted) throw new Error('Repository operation cancelled');
    await mkdir(resolve(root, 'repositories'), { recursive: true });
    await rename(stage, project.repositoryPath);
  }
}
