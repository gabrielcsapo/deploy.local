import type { ShipChoices } from '../../../../../server/v2/releases-plan.ts';
import type { Release } from '../../../../../shared/v2/contracts.ts';
import type { TaskDiff, TaskPull } from './types.ts';

export async function requestJson<T>(
  request: typeof fetch,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await request(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status}). Try again.`);
  }
  return response.json();
}
export async function shipProject(
  request: typeof fetch,
  project: string,
  ref: string,
  choices?: ShipChoices,
): Promise<Release> {
  const response = await request(`/api/projects/${encodeURIComponent(project)}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: { kind: 'ship', ref }, ref, choices }),
  });
  if (response.status === 404)
    throw new Error('Shipping needs the new release engine on this coordinator');
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Shipping could not start (${response.status}). Try again.`);
  }
  const body = await response.json();
  if (!body.release?.id || !Array.isArray(body.release.steps))
    throw new Error('The coordinator returned no release. Check Releases before trying again.');
  return body.release;
}
export function workspaceCommand<T>(request: typeof fetch, path: string, body: object) {
  return requestJson<T>(request, `/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, operationId: crypto.randomUUID() }),
  });
}
export function mergePull(request: typeof fetch, project: string, pull: TaskPull, diff: TaskDiff) {
  if (!diff.baseCommit || !diff.headCommit)
    throw new Error('Load the current changes before merging.');
  return workspaceCommand(
    request,
    `/projects/${encodeURIComponent(project)}/pulls/${encodeURIComponent(pull.id)}/merge`,
    {
      revision: pull.revision,
      baseCommit: diff.baseCommit,
      headCommit: diff.headCommit,
    },
  );
}

export function parsePatch(patch: string) {
  const files: {
    file: string;
    lines: { kind?: 'add' | 'del' | 'hunk'; old?: number; new?: number; text: string }[];
    added: number;
    removed: number;
  }[] = [];
  let current: (typeof files)[number] | undefined;
  let old = 0,
    next = 0;
  for (const text of patch.split('\n')) {
    if (text.startsWith('diff --git ')) {
      current = {
        file: text.replace(/^diff --git a\/.* b\//, ''),
        lines: [],
        added: 0,
        removed: 0,
      };
      files.push(current);
    } else if (current && text.startsWith('@@')) {
      const match = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (match) {
        old = Number(match[1]);
        next = Number(match[2]);
      }
      current.lines.push({ kind: 'hunk', text });
    } else if (current && !text.startsWith('+++') && !text.startsWith('---')) {
      if (text.startsWith('+')) {
        current.added++;
        current.lines.push({ kind: 'add', new: next++, text: text.slice(1) });
      } else if (text.startsWith('-')) {
        current.removed++;
        current.lines.push({ kind: 'del', old: old++, text: text.slice(1) });
      } else if (text.startsWith(' '))
        current.lines.push({ old: old++, new: next++, text: text.slice(1) });
      else if (
        text.startsWith('Binary files') ||
        text.startsWith('rename ') ||
        text.startsWith('new file mode') ||
        text.startsWith('deleted file mode')
      )
        current.lines.push({ text });
    }
  }
  return files;
}

export type TaskStreamEvent = { taskId?: string } & (
  | { type: 'release'; release: Release }
  | {
      type: 'conversation';
      event: import('../../../../../shared/v2/contracts.ts').ConversationEvent;
    }
  | { type: 'inbox' }
);
export function updateTaskFromEvents(
  view: import('./types.ts').TaskView,
  events: TaskStreamEvent[],
) {
  let next = view;
  for (const item of events) {
    if (
      item.type === 'conversation' &&
      item.taskId === view.task.id &&
      !(item.event.kind === 'task' && item.event.taskId === view.task.id)
    ) {
      const byId = new Map(next.events.map((event) => [event.id, event]));
      byId.set(item.event.id, item.event);
      next = { ...next, events: [...byId.values()] };
    }
    if (item.type === 'release' && item.release.projectId === view.project?.id)
      next = {
        ...next,
        releases: [
          ...next.releases.filter((release) => release.id !== item.release.id),
          item.release,
        ],
      };
  }
  return next;
}

/** Recorded workspace checks already carry their result; only pipeline runs have job endpoints. */
export async function readPullChecks(
  request: typeof fetch,
  project: string,
  pull: string,
  headCommit: string,
  signal?: AbortSignal,
) {
  const base = `/api/projects/${encodeURIComponent(project)}`;
  const detail = await requestJson<{ checks: import('./types.ts').TaskCheck[] }>(
    request,
    `${base}/pulls/${encodeURIComponent(pull)}`,
    { signal },
  );
  const current = detail.checks.filter((check) => check.commit === headCommit);
  const recorded = current.filter((check) => check.source);
  const run = current.find((check) => !check.source);
  const pipeline = run
    ? await requestJson<{ jobs: import('./types.ts').TaskCheck[] }>(
        request,
        `${base}/pipelines/${encodeURIComponent(run.id)}`,
        { signal },
      )
    : { jobs: [] };
  return [...pipeline.jobs, ...recorded].map((job) => ({ ...job, headCommit }));
}

/** Release only the commit the merge worker actually landed, after it reports success. */
export async function mergeAndRelease(
  request: typeof fetch,
  project: string,
  pull: TaskPull,
  diff: TaskDiff,
  wait = () => new Promise<void>((resolve) => setTimeout(resolve, 1000)),
) {
  const queued = (await mergePull(request, project, pull, diff)) as { mergeOperationId: string };
  for (let attempt = 0; attempt < 60; attempt++) {
    const detail = await requestJson<{
      record: TaskPull & { mergeOperationId?: string };
      mergeOperation?: { status: string; error?: string };
    }>(
      request,
      `/api/projects/${encodeURIComponent(project)}/pulls/${encodeURIComponent(pull.id)}`,
    );
    if (detail.record.mergeOperationId !== queued.mergeOperationId)
      throw new Error('The merge changed. Review the pull request before releasing.');
    if (detail.record.status === 'merged') {
      const ref = detail.record.mergedTargetCommit || detail.record.mergedCommit;
      if (!ref) throw new Error('The merge did not record a commit to release.');
      const body = await requestJson<{ release: Release }>(
        request,
        `/api/projects/${encodeURIComponent(project)}/releases`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: { kind: 'pr', ref: String(pull.number) }, ref }),
        },
      );
      return body.release;
    }
    if (['failed', 'cancelled', 'unknown'].includes(detail.mergeOperation?.status || ''))
      throw new Error(
        detail.mergeOperation?.error ||
          'The merge stopped. Review the pull request before retrying.',
      );
    await wait();
  }
  throw new Error('The merge is still pending. Check the pull request before releasing.');
}
