import { publishTitle, taskTitle } from '../../shared/task-title.ts';
import { mergedPublication } from './follow-up.ts';
import { projectActivity } from './activity.ts';
import { activityEvents, list } from './store.ts';
type Row = Record<string, any>;

/** Derived at read time, never persisted as a task lifecycle status. */
export function taskPullSummary<T extends Row>(task: T, pulls: Row[]) {
  const linked = pulls.filter(
    (p) => p.projectId === task.projectId && p.taskIds?.includes(task.id),
  );
  // After follow-ups the latest merged pull request is the one that matters.
  const pull =
    linked.find((p) => p.status === 'open') || linked.findLast((p) => p.status === 'merged');
  return { ...task, pull: pull ? { id: pull.id, number: pull.number, status: pull.status } : null };
}

/** Local file links are useful in chat, but do not resolve for reviewers. */
export function stripWorkspaceLinks(markdown: string, workspace: string): string {
  const root = workspace.replace(/\/$/, '');
  function localPath(destination: string): string | null {
    let path = destination.replace(/^<|>$/g, '').replace(/^file:\/\//, '');
    try {
      path = decodeURIComponent(path);
    } catch {
      /* Keep literal paths with invalid escapes. */
    }
    const suffix = path.match(/(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/)?.[0] || '';
    path = path.slice(0, path.length - suffix.length);
    if (!path.startsWith('/')) return null;
    return root && path.startsWith(root + '/')
      ? path.slice(root.length + 1)
      : path.split('/').at(-1) || '';
  }
  const references = new Map<string, string>();
  const withoutDefinitions = markdown.replace(
    /^ *\[([^\]]+)\]:[ \t]*(<[^>]+>|\S+).*$/gm,
    (definition, label, destination) => {
      const path = localPath(destination);
      if (path === null) return definition;
      references.set(label.trim().toLowerCase(), path);
      return '';
    },
  );
  return withoutDefinitions
    .replace(
      /!?\[([^\]]*)\]\((<[^>]+>|(?:[^()\s]|\([^()]*\))+)(?:\s+"[^"]*")?\)/g,
      (link, _label, destination) => localPath(destination) ?? link,
    )
    .replace(
      /!?\[([^\]]+)\](?:\[([^\]]*)\])?(?!\()/g,
      (link, label, reference) => references.get((reference || label).trim().toLowerCase()) ?? link,
    );
}

export function publishDescription(task: Row, messages: Row[], checks: Row[], jobs: Row[]) {
  const summary = messages.findLast((m) => m.role === 'assistant' && !m.isProgress)?.content || '';
  const rows = [...checks, ...jobs].map((check) => {
    const terminal = ['succeeded', 'passed', 'completed', 'failed'].includes(check.status);
    const failed =
      check.status === 'failed' ||
      ((terminal || !check.status) && check.exitCode != null && check.exitCode !== 0);
    const passed =
      !failed &&
      (['succeeded', 'passed'].includes(check.status) ||
        (check.exitCode === 0 && (!check.status || check.status === 'completed')));
    const result = failed ? 'Failed' : passed ? 'Passed' : 'Not run';
    const detail = !passed && !failed && check.status ? ` (${check.status})` : '';
    return `- ${check.name || check.command || 'Recorded check'}: ${result}${detail}`;
  });
  return stripWorkspaceLinks(
    [
      summary.trim(),
      `## Checks\n${rows.length ? rows.join('\n') : '- Not run (no recorded checks or jobs).'}`,
      `Task: ${publishTitle(task.title, messages.find((m) => m.role === 'user' && !m.shell)?.content)}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
    task.remoteWorkspacePath || task.workspacePath || '',
  );
}

export function taskPublishDefaults(owner: string, task: Row) {
  const messages = list('message', owner).filter((m) => m.taskId === task.id);
  const runs = list('run', owner).filter((r) => r.taskId === task.id);
  const annotated = projectActivity(activityEvents(owner, task.id), runs, messages).messages;
  const checks =
    task.workerId && task.workerId !== 'local'
      ? list('remote-diff', owner).find((d) => d.id === task.id)?.checks || []
      : list('check', owner).filter((c) => c.taskId === task.id);
  // A follow-up after a merged pull request is titled after the first request since then.
  const requests = messages.filter((m) => m.role === 'user');
  const boundary = requests.findIndex((m) => m.id === task.publishedMessageId);
  const followUp =
    mergedPublication(owner, task) && boundary >= 0 ? requests[boundary + 1]?.content : '';
  return {
    title: followUp?.trim() ? taskTitle(followUp) : publishTitle(task.title, requests[0]?.content),
    body: publishDescription(
      task,
      annotated,
      checks,
      list('job', owner).filter((j) => j.taskId === task.id),
    ),
  };
}
