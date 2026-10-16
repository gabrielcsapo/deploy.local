import { providerUsage } from './provider-usage.ts';
import { computers } from './coordination.ts';
import { modelOptions, validateRunSettings } from './model-options.ts';
import { activeCheck } from './checks.ts';
import { inspectWorkspace } from './review.ts';
import { spawnSync } from 'node:child_process';
import { list, get, save, event, id, now, revise } from './store.ts';
export function git(cwd: string, args: string[]) {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60000,
  });
  if (r.status !== 0) throw new Error(r.stderr || 'Git failed');
  return r.stdout.trimEnd();
}
export function startRun(owner: string, taskId: string, input: any) {
  const task = get('task', owner, taskId);
  revise(task, input.revision);
  if (task.workspaceStatus && !['ready', 'preparing'].includes(task.workspaceStatus))
    throw Object.assign(new Error('Workspace preparation needs recovery'), { status: 409 });
  if (
    list('run', owner).some(
      (r) => r.taskId === taskId && ['queued', 'starting', 'running', 'unknown'].includes(r.status),
    )
  )
    throw Object.assign(new Error('Task already has an active run'), { status: 409 });
  if (activeCheck(owner, taskId))
    throw Object.assign(new Error('Task has an active check'), { status: 409 });
  const adapter = input.adapter || 'codex';
  if (!['codex', 'claude', 'compatible'].includes(adapter)) throw new Error('Unsupported adapter');
  if (
    (!task.workerId || task.workerId === 'local') &&
    adapter === 'compatible' &&
    (!process.env.DEPLOY_MODEL_BASE_URL || !process.env.DEPLOY_MODEL_BILLING_MODE)
  )
    throw new Error('Compatible endpoint is not explicitly configured on this coordinator');
  const options =
    !task.workerId || task.workerId === 'local'
      ? modelOptions()
      : get('worker', owner, task.workerId).modelOptions || [];
  const settings = validateRunSettings({ ...input, adapter }, options);
  const content = String(input.content || '').trim();
  if (!content || content.length > 100000)
    throw new Error('Message required (maximum 100000 characters)');
  const msg = { id: id(), taskId, role: 'user', content, createdAt: now() };
  save('message', owner, msg);
  event(owner, taskId, null, 'message', msg);
  const prior = list('run', owner)
    .filter((r) => r.taskId === taskId && r.sessionId && r.adapter === (input.adapter || 'codex'))
    .at(-1);
  const run = {
    id: id(),
    taskId,
    adapter,
    workerId: task.workerId || 'local',
    ...settings,
    status: 'queued',
    sessionId: prior?.sessionId || null,
    createdAt: now(),
    updatedAt: now(),
    error: null,
    prompt: (() => {
      const last = list('run', owner)
        .filter((r) => r.taskId === taskId)
        .at(-1);
      if (last && last.adapter !== adapter) {
        const history = list('message', owner)
          .filter((m) => m.taskId === taskId)
          .slice(-20)
          .map((m) => m.role + ': ' + m.content)
          .join('\n')
          .slice(-40000);
        return (
          'Adapter handoff. Task: ' +
          task.title +
          '\nShared conversation:\n' +
          history +
          '\nCurrent user instruction:\n' +
          content
        );
      }
      const issue = task.issueId ? get('issue', owner, task.issueId) : null;
      return issue && !prior
        ? `Linked project issue #${issue.number}: ${issue.title}\n${issue.body}\n\nCurrent user instruction:\n${content}`
        : content;
    })(),
  };
  save('run', owner, run);
  save('task', owner, {
    ...task,
    status: 'running',
    revision: task.revision + 1,
    updatedAt: now(),
  });
  event(owner, taskId, run.id, 'run.queued', run);
  return run;
}
export function stopRun(owner: string, taskId: string, input: any) {
  const task = get('task', owner, taskId);
  revise(task, input.revision);
  for (const run of list('run', owner).filter(
    (r) => r.taskId === taskId && ['queued', 'starting', 'running', 'unknown'].includes(r.status),
  )) {
    save('run', owner, { ...run, stopRequested: true });
    event(owner, taskId, run.id, 'run.stopRequested', {});
  }
  for (const job of list('job', owner).filter(
    (j) => j.taskId === taskId && ['queued', 'running'].includes(j.status),
  )) {
    save('job', owner, {
      ...job,
      stopRequested: true,
      status: job.status === 'queued' ? 'cancelled' : job.status,
      updatedAt: now(),
    });
    event(owner, taskId, job.runId, 'job.cancel_requested', {
      jobId: job.id,
      workerId: job.workerId,
    });
  }
  const check = activeCheck(owner, taskId);
  if (check) {
    save('check', owner, { ...check, stopRequested: true });
    event(owner, taskId, null, 'check.stopRequested', { id: check.id });
  }
  return save('task', owner, { ...task, revision: task.revision + 1, updatedAt: now() });
}
export function diff(owner: string, taskId: string) {
  const t = get('task', owner, taskId);
  if (t.workspaceStatus && t.workspaceStatus !== 'ready')
    return {
      baseRevision: t.baseRevision,
      headRevision: t.baseRevision,
      patch: '',
      files: [],
      excluded: [],
      checks: [],
      status: 'Workspace ' + t.workspaceStatus,
    };
  if (t.workerId && t.workerId !== 'local') {
    try {
      return get('remote-diff', owner, taskId);
    } catch {
      return {
        baseRevision: t.baseRevision,
        headRevision: t.baseRevision,
        patch: '',
        status: 'Remote workspace changes have not been uploaded',
        files: [],
        checks: [],
      };
    }
  }
  return {
    ...inspectWorkspace(t.workspacePath, t.baseRevision),
    checks: list('check', owner).filter((c) => c.taskId === taskId),
  };
}
export function capabilities(owner?: string) {
  const available = spawnSync('codex', ['--version'], { encoding: 'utf8' }).status === 0;
  const local = computers(owner || '')[0];
  return {
    workers: [
      {
        ...local,
        modelOptions: modelOptions(),
        providers: providerUsage(),
        capabilities: [...local.capabilities, ...(available ? ['codex'] : [])],
      },
      ...(owner
        ? list('worker', owner).map((w) => ({
            ...w,
            status: Date.now() - Date.parse(w.heartbeat) < 10000 ? 'online' : 'offline',
          }))
        : []),
    ],
    adapters: [
      {
        id: 'claude',
        name: 'Claude Code',
        available:
          spawnSync(process.env.DEPLOY_CLAUDE_BIN || 'claude', ['--version'], { encoding: 'utf8' })
            .status === 0,
        capabilities: {
          resume: true,
          cancellation: true,
          questions: true,
          steering: false,
          permissions: false,
          browser: false,
          computer: false,
        },
        billingMode: 'worker-account (quota unknown)',
      },
      {
        id: 'compatible',
        name: 'Compatible model endpoint',
        available: Boolean(
          process.env.DEPLOY_MODEL_BASE_URL && process.env.DEPLOY_MODEL_BILLING_MODE,
        ),
        capabilities: {
          resume: true,
          cancellation: true,
          questions: true,
          steering: false,
          permissions: false,
          browser: false,
          computer: false,
        },
        billingMode: process.env.DEPLOY_MODEL_BILLING_MODE || 'not configured',
      },
      {
        id: 'codex',
        name: 'Codex CLI',
        available,
        capabilities: {
          resume: true,
          cancellation: true,
          questions: true,
          steering: false,
          permissions: false,
          browser: false,
          computer: false,
        },
        billingMode: 'worker-account (quota unknown)',
      },
    ],
  };
}
