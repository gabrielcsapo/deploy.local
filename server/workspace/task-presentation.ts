import { taskWorkspaceChecks } from './workspace-checks.ts';
import { scrubCheckText } from './workspace-verification.ts';
import { changeTitle, taskTitle } from '../../shared/task-title.ts';
import { type CheckLabelContext, checkCommandLabel } from '../../shared/check-label.ts';
import {
  checkAttempts,
  checkRuns,
  earlierAttemptsLabel,
  earlierRunsLabel,
  noHeadChecksMessage,
  resultUnreadable,
  unknownResultMessage,
} from '../../shared/check-attempts.ts';
import { editWatermark, projectActivity } from './activity.ts';
import { publishHead } from './checkpoint-publish.ts';
import { diff } from './service.ts';
import { activityEvents, get, list } from './store.ts';
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

/** A worker's filesystem layout identifies a computer, not the change; keep the file name only. */
export function scrubWorkspacePaths(text: string, roots: (string | undefined)[]): string {
  let result = text;
  for (const root of roots)
    if (root) {
      const base = root.replace(/\/$/, '');
      result = result.replaceAll('file://' + base + '/', '').replaceAll(base + '/', '');
      // The root on its own ("cd <workspace>"), which the rule below cannot reach: a Mac keeps
      // its tasks under `~/Library/Application Support/…`, and that space ends the match, so the
      // tail of the worker's own layout used to survive.
      result = result.replaceAll('file://' + base, '.').replaceAll(base, '.');
    }
  return result.replace(
    /(?<![\w/:])(?:file:\/\/)?\/(?:Users|home|private|tmp|var)\/[^\s`<>"()[\]]+/g,
    (path) => path.split('/').at(-1) || '',
  );
}

const workspaceRoots = (task: Row) => [task.remoteWorkspacePath, task.workspacePath];
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Lines that report on the conversation rather than on the change. */
const chatter = [
  // Publication is the owner's step, so an agent's account of not taking it says nothing here.
  /\b(?:no|not)\b[^.]*\b(?:pull request|pr)\b[^.]*\b(?:created|opened|published|raised)\b/i,
  /\bnothing (?:was|is|has been)\s+(?:\w+\s+){0,2}?(?:merged|published|committed|pushed)\b/i,
  /\bi\s+(?:did not|didn'?t|have not|haven'?t|will not|won'?t)\s+(?:\w+\s+){0,3}?(?:publish|merge|commit|push|open)\b/i,
  /\b(?:ready|left|waiting) for (?:you|the owner)\b/i,
  /\bthe owner (?:publishes|can publish|merges|can merge|reviews)\b/i,
  /\b(?:captured|capturing) (?:a|the) (?:final |fresh |last |new )?checkpoint\b/i,
  // Tool narration: what the agent was doing, not what the change is.
  /^(?:let me|i'?ll|i will|i'?m going to|next,? i|now i|first,? i|running|starting|checking|verifying|looking at|reading|searching|inspecting|dispatching)\b/i,
  /\bdeploy_(?:run_job|get_job|list_jobs|checkpoint|commit|application|list_computers|ask_user|attach|control)\b/,
  /\bjob\s+\w[\w-]*\s+(?:queued|running|finished|dispatched)\b/i,
];

/**
 * The summary the agent wrote, when its final message reads like one. Chat lines are dropped
 * rather than the whole message: a good summary often ends with a note about publishing.
 * An empty result means the message was chatter, and the caller describes the commit instead.
 */
export function agentSummary(content: string): string {
  let fenced = false;
  const kept = content.split('\n').filter((line) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced || /^\s*```/.test(line)) return true;
    return !line.trim() || !chatter.some((pattern) => pattern.test(line.trim()));
  });
  const text = kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // Prose, with Markdown furniture discounted: a heading or a bare "Done." is not a summary.
  const prose = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+.*$/gm, ' ')
    .replace(/[*_`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return prose.length >= 15 && prose.split(' ').length >= 2 ? text : '';
}

type FileChange = { path: string; additions: number; deletions: number };

/** Changed files with their line counts, read from a unified diff. */
export function patchFiles(patch: string): FileChange[] {
  const files: FileChange[] = [];
  let current: FileChange | null = null;
  const name = (value: string) =>
    value
      .replace(/\t.*$/, '')
      .replace(/^"(.*)"$/, '$1')
      .replace(/^[ab]\//, '');
  // Inside a hunk every `+`/`-` is a changed line, so headers can never be miscounted.
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      // The b/ side names the file after the change; `+++` refines it for text files below.
      const paths = line.slice('diff --git '.length);
      const divider = paths.lastIndexOf(' b/');
      const quoted = paths.lastIndexOf(' "b/');
      const path = divider > 0 ? paths.slice(divider + 1) : paths.slice(quoted + 1);
      current = { path: name(path), additions: 0, deletions: 0 };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('@@')) inHunk = true;
    else if (inHunk && line.startsWith('+')) current.additions++;
    else if (inHunk && line.startsWith('-')) current.deletions++;
    else if (line.startsWith('+++ ') && !line.endsWith('/dev/null'))
      current.path = name(line.slice(4));
    else if (line.startsWith('rename to ')) current.path = name(line.slice(10));
  }
  return files;
}

/**
 * A description of the commit itself: its changed files grouped by directory with line counts.
 * Used when the agent's final message is not a summary, so a reviewer still reads what changed.
 */
export function changeSummary(patch: string): string {
  const files = patchFiles(patch);
  if (!files.length) return '';
  const areas = new Map<string, { files: number; additions: number; deletions: number }>();
  for (const file of files) {
    const area = file.path.includes('/')
      ? file.path.slice(0, file.path.lastIndexOf('/'))
      : 'repository root';
    const total = areas.get(area) ?? { files: 0, additions: 0, deletions: 0 };
    areas.set(area, {
      files: total.files + 1,
      additions: total.additions + file.additions,
      deletions: total.deletions + file.deletions,
    });
  }
  const ordered = [...areas].sort(
    (a, b) =>
      b[1].additions + b[1].deletions - (a[1].additions + a[1].deletions) ||
      a[0].localeCompare(b[0]),
  );
  const shown = ordered.slice(0, 8);
  return [
    `Changed ${plural(files.length, 'file')} across ${plural(ordered.length, 'area')}:`,
    ...shown.map(
      ([area, total]) =>
        `- ${area}: ${plural(total.files, 'file')}, +${total.additions} −${total.deletions}`,
    ),
    ordered.length > shown.length
      ? `- …and ${plural(ordered.length - shown.length, 'more area')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** A retry of the same command on the same computer is another attempt at one check; the same
 * command on another computer is a separate check, because it verifies somewhere else. */
const checkKey = (check: Row) =>
  JSON.stringify([
    check.source ?? null,
    check.workerId ?? null,
    check.name?.trim() ||
      // Two runs that differ only in their shell plumbing are attempts at the same check.
      String(check.label || check.command || '')
        .replace(/\s+/g, ' ')
        .trim(),
  ]);

/** Where one recorded run stands, from whatever it carries: a status, or only an exit code. */
function checkResult(run: Row) {
  // A piped command's exit code is `tail`'s. When its output did not say either, the run
  // reports that rather than a result it cannot support.
  if (resultUnreadable(run)) return unknownResultMessage;
  const terminal = ['succeeded', 'passed', 'completed', 'failed'].includes(run.status);
  const failed =
    run.status === 'failed' ||
    ((terminal || !run.status) && run.exitCode != null && run.exitCode !== 0);
  const passed =
    !failed &&
    (['succeeded', 'passed'].includes(run.status) ||
      (run.exitCode === 0 && (!run.status || run.status === 'completed')));
  const detail = !passed && !failed && run.status ? ` (${run.status})` : '';
  return (failed ? 'Failed' : passed ? 'Passed' : 'Not run') + detail;
}

/**
 * What the published change's head is, and what a recorded run has to carry to belong to it: a
 * job names the checkpoint it ran against, and a check names the edit watermark of the
 * workspace it read. A run that says neither ran against something this coordinator cannot
 * place, so it reads as an earlier run rather than as a result the pull request claims.
 */
export type PublishedHead = { digest?: string | null; watermark?: string | null };

function ranOnHead(run: Row, head: PublishedHead): boolean {
  if (run.checkpointId || run.digest != null)
    return head.digest != null && run.digest === head.digest;
  if ('watermark' in run) return run.watermark === head.watermark;
  return false;
}

/** How many earlier runs a description names one by one before it only counts them. */
const earlierRunsShown = 10;

/** One check, however many times it ran against the published change: its latest result, with
 * earlier attempts collapsed, and everything from before the last edit kept separate. */
function checkRows(
  checks: Row[],
  jobs: Row[],
  clean: (text: string) => string,
  head: PublishedHead | null,
  context: CheckLabelContext = {},
) {
  const runs = [...checks, ...jobs];
  const partitioned = head
    ? checkRuns(runs, checkKey, (run) => ranOnHead(run, head))
    : { current: checkAttempts(runs, checkKey), earlier: [] as Row[] };
  const tidy = (text: string) => clean(scrubCheckText(text)).replace(/\s+/g, ' ').trim();
  const line = (run: Row, suffix = '') => {
    const command = tidy(String(run.command ?? ''));
    // A command's shell plumbing and the worker directory it starts in say nothing about the
    // check; the headline is what ran, and the command itself follows underneath.
    const label =
      run.name?.trim() || run.label?.trim() || checkCommandLabel(command, context) || command;
    // A result read from a piped command's output names the lines it was read from, so a
    // reviewer can see what the coordinator went on instead of an exit code.
    const read = run.evidence ? ` (output: ${tidy(String(run.evidence)).slice(0, 120)})` : '';
    const result = `- ${tidy(label) || 'Recorded check'}: ${checkResult(run)}${read}${suffix}${run.sourceLabel ? ` · ${run.sourceLabel}` : ''}`;
    // Nothing is hidden: a command the headline summarized is kept, in full, under it.
    return command && command !== label
      ? `${result}\n  - Command: \`${command.slice(0, 300)}\``
      : result;
  };
  return {
    recorded: runs.length,
    current: partitioned.current.map(({ latest, earlier }) => {
      const attempts = earlierAttemptsLabel(earlier.length + (latest.attempts ?? 1) - 1);
      return line(latest, attempts ? ` (${attempts})` : '');
    }),
    earlierCount: partitioned.earlier.length,
    earlier: [
      ...partitioned.earlier.slice(0, earlierRunsShown).map((run) => line(run)),
      ...(partitioned.earlier.length > earlierRunsShown
        ? [`- …and ${plural(partitioned.earlier.length - earlierRunsShown, 'older run')}`]
        : []),
    ],
  };
}

/**
 * The description a pull request is prefilled with: the request the task was given, a summary
 * of the change, and where its checks stand. `changes` describes the commit (see
 * `changeSummary`) and is only consulted when neither the checkpoint's own summary nor the
 * agent's final message is usable, so passing it as a function keeps that cost off the common
 * path. `head` is the version being published: without it nothing can be placed, and every
 * recorded run reads as current.
 */
export function publishDescription(
  task: Row,
  messages: Row[],
  checks: Row[],
  jobs: Row[],
  changes: string | (() => string) = '',
  head: PublishedHead | null = null,
  written = '',
) {
  const clean = (text: string) =>
    scrubWorkspacePaths(
      stripWorkspaceLinks(text, task.remoteWorkspacePath || task.workspacePath || ''),
      workspaceRoots(task),
    );
  const request = messages.find((m) => m.role === 'user' && !m.shell)?.content || task.title || '';
  const final = messages.findLast((m) => m.role === 'assistant' && !m.isProgress)?.content || '';
  // The summary the agent wrote on its checkpoint describes the change it published; its final
  // message only sometimes does, and the commit's shape never more than counts files.
  const summary =
    clean(written).trim() ||
    agentSummary(clean(final).trim()) ||
    (typeof changes === 'function' ? changes() : changes);
  const rows = checkRows(checks, jobs, clean, head, {
    id: task.id,
    workspacePath: task.workspacePath,
    remoteWorkspacePath: task.remoteWorkspacePath,
  });
  const asked = taskTitle(clean(request), 160);
  return [
    asked && `Request: ${asked}`,
    summary,
    `## Checks\n${
      rows.current.length
        ? rows.current.join('\n')
        : rows.recorded
          ? `${noHeadChecksMessage}.`
          : '- Not run (no recorded checks or jobs).'
    }`,
    // Runs from before the last edit are kept, with their results, but never counted: a failure
    // that was fixed afterwards is history, not the state of the change.
    rows.earlierCount && `### ${earlierRunsLabel(rows.earlierCount)}\n${rows.earlier.join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Reading the workspace diff costs a Git process, and clients poll task detail. The last
 * recorded activity is the watermark: any command or file change invalidates the summary. */
const describedChange = new Map<string, string>();

export function taskPublishDefaults(owner: string, task: Row) {
  const messages = list('message', owner).filter((m) => m.taskId === task.id);
  const runs = list('run', owner).filter((r) => r.taskId === task.id);
  const events = activityEvents(owner, task.id);
  const annotated = projectActivity(events, runs, messages).messages;
  const watermark = [
    owner,
    task.id,
    events.at(-1)?.cursor ?? '',
    task.revision ?? '',
    task.baseRevision ?? '',
  ].join(':');
  const checks =
    task.workerId && task.workerId !== 'local'
      ? list('remote-diff', owner).find((d) => d.id === task.id)?.checks || []
      : list('check', owner).filter((c) => c.taskId === task.id);
  const request = messages.find((m) => m.role === 'user' && !m.shell)?.content;
  const head = publishHead(owner, task.id, events);
  // The project a change belongs to is not news in its title.
  let project = '';
  try {
    if (task.projectId) project = get('project', owner, task.projectId).name || '';
  } catch {
    project = '';
  }
  return {
    // The agent names its own change; a title derived from the request is the fallback, and
    // follow-up messages report on the conversation ("The limit is fixed…"), never on the work.
    title: head.title || changeTitle(task.title ?? '', request ?? '', 72, project),
    body: publishDescription(
      task,
      annotated,
      [
        ...checks.map((check: Row) => ({ ...check, sourceLabel: 'Ran as a coordinator check' })),
        ...taskWorkspaceChecks(owner, task.id, events),
      ],
      list('job', owner)
        .filter((j) => j.taskId === task.id)
        .map((j) => ({ ...j, sourceLabel: 'Ran as a recorded job' })),
      () => {
        const cached = describedChange.get(watermark);
        if (cached !== undefined) return cached;
        let summary = '';
        try {
          const snapshot: any = diff(owner, task.id);
          // A truncated patch would undercount the change; say nothing rather than mislead.
          summary = snapshot.truncated ? '' : changeSummary(snapshot.patch || '');
        } catch {
          summary = '';
        }
        if (describedChange.size > 200) describedChange.clear();
        describedChange.set(watermark, summary);
        return summary;
      },
      { digest: head.digest, watermark: editWatermark(events) },
      head.summary ?? '',
    ),
  };
}
