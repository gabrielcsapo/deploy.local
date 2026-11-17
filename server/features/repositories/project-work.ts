/**
 * A project's work as one list by stage. Tasks, pull requests and issues are folded into work
 * items: a task with its pull request and its issue is one row. `stageProjectWork` is pure so the
 * staging rules are tested without a store; `readProjectWork` gathers its input.
 */
type Row = Record<string, any>;

export type WorkStage = 'needs-you' | 'running' | 'up-next' | 'found' | 'shipped';
export const OPEN_STAGES: WorkStage[] = ['needs-you', 'running', 'up-next', 'found'];

export type WorkRow = {
  id: string;
  title: string;
  stage: WorkStage;
  /** The pull request's number when there is one, else the issue's. */
  number?: number;
  /** The meta line, joined with " · " when shown. */
  meta: string[];
  /** When the row last changed, for the time at its end and the order within a stage. */
  at: string;
  /** Where the row opens: the task's page, the pull request's page, or the issue itself. */
  link: { kind: 'task' | 'pull' | 'issue'; id: string };
  /** The issue a row opens in place, with what its actions need. */
  issue?: { id: string; number?: number; revision: number; body: string };
};

export type ProjectWork = {
  /** The open rows, Needs you first, then Running, Up next and Found by agents. */
  rows: WorkRow[];
  /** Merged and closed work, newest first. */
  shipped: WorkRow[];
  counts: { open: number; shipped: number };
};

export type WorkInput = {
  tasks: Row[];
  issues: Row[];
  pulls: Row[];
  runs: Row[];
  /** Waiting on you, any project: only items with a task in this project count. */
  inbox: { kind: string; state: string; taskId?: string; title?: string; createdAt?: string }[];
  waitingForAnswer: Set<string>;
  controlRequests: Set<string>;
  /** Published task checks for each open pull request, by pull request ID. */
  checks?: Map<string, { passed: number; failed: number; total: number }>;
  /** Pull requests whose merge is queued or running. */
  merging?: Set<string>;
  agentName: (agentId: string | undefined) => string | undefined;
  personName: (username: string) => string;
  computerName: (workerId: string) => string | undefined;
  now: number;
};

/** Task statuses after which a task is no longer live work. */
const ENDED = new Set(['merged', 'done', 'completed', 'closed', 'cancelled', 'deleted']);
/** Finished well: shipped. The others ended without shipping. */
const SHIPPED = new Set(['merged', 'done', 'completed']);
const STOPPED = new Set(['failed']);
const PAUSED = new Set(['blocked', 'interrupted', 'stalled', 'unknown']);
const WORKING = new Set(['queued', 'preparing', 'starting', 'running', 'checking']);

const time = (row: Row | undefined) => String(row?.updatedAt || row?.createdAt || '');
const latest = (...values: (string | undefined)[]) =>
  values.filter(Boolean).sort().at(-1) || new Date(0).toISOString();

/** Agent-found issues carry who found them until the owner adds them to Up next. */
export const foundByAgent = (issue: Row) => !!issue.foundBy && !issue.accepted;

function duration(from: string, now: number) {
  const minutes = Math.floor((now - Date.parse(from)) / 60000);
  if (!Number.isFinite(minutes) || minutes < 1) return 'just started';
  if (minutes < 60) return `for ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `for ${hours} h` : `for ${Math.floor(hours / 24)} d`;
}

export function stageProjectWork(input: WorkInput): ProjectWork {
  const { now } = input;
  const latestRun = new Map<string, Row>();
  for (const run of [...input.runs].sort((a, b) =>
    String(a.createdAt).localeCompare(String(b.createdAt)),
  ))
    latestRun.set(run.taskId, run);
  const waiting = new Map<string, WorkInput['inbox'][number]>();
  for (const item of input.inbox)
    if (item.state === 'waiting' && item.taskId && !waiting.has(item.taskId))
      waiting.set(item.taskId, item);
  const usedPulls = new Set<string>();
  const usedIssues = new Set<string>();
  const rows: WorkRow[] = [];
  const shipped: WorkRow[] = [];

  const foundMeta = (issue: Row) => {
    const name = input.agentName(issue.foundBy?.agentId) || 'an agent';
    const pull = input.pulls.find((row) => row.taskIds?.includes(issue.foundBy?.taskId));
    return `Found by ${name}${pull ? ` in PR #${pull.number}` : ''}`;
  };
  const issueOf = (issue: Row): WorkRow['issue'] => ({
    id: issue.id,
    number: issue.number,
    revision: issue.revision ?? 0,
    body: issue.body ?? '',
  });

  // Newest task first, so a pull request or issue several tasks share folds into the latest.
  const tasks = [...input.tasks].sort((a, b) => time(b).localeCompare(time(a)));
  for (const task of tasks) {
    if (['closed', 'cancelled', 'deleted'].includes(task.status)) continue;
    const linkedPulls = input.pulls.filter(
      (pull) => !usedPulls.has(pull.id) && pull.taskIds?.includes(task.id),
    );
    // After follow-ups the open pull request is the one that matters, else the last merged one.
    const pull =
      linkedPulls.find((row) => row.status === 'open') ||
      linkedPulls.findLast((row) => row.status === 'merged') ||
      linkedPulls.at(-1);
    // The task an agent found an issue in is not work on that issue.
    const issue = input.issues.find(
      (row) =>
        !usedIssues.has(row.id) &&
        row.foundBy?.taskId !== task.id &&
        (row.id === task.issueId ||
          row.taskIds?.includes(task.id) ||
          (pull && pull.issueIds?.includes(row.id))),
    );
    const run = latestRun.get(task.id);
    const ended = ENDED.has(task.status) || pull?.status === 'merged';
    const status = ended ? task.status : run?.status || task.status;
    const merged = pull?.status === 'merged' || SHIPPED.has(task.status);
    if (ended && !merged) continue;
    for (const row of linkedPulls) usedPulls.add(row.id);
    if (issue) usedIssues.add(issue.id);
    const title = task.title || pull?.title || issue?.title || 'Untitled task';
    const number = pull?.number ?? issue?.number;
    const hash = number !== undefined ? `#${number}` : undefined;
    const at = latest(time(task), time(pull), time(run));
    const base = { id: `task:${task.id}`, title, number, at };
    if (merged) {
      shipped.push({
        ...base,
        stage: 'shipped',
        meta: [pull?.status === 'merged' ? 'Merged' : 'Done', hash].filter(Boolean) as string[],
        at: latest(pull?.mergedAt, task.closedAt, at),
        link: { kind: 'task', id: task.id },
      });
      continue;
    }
    const found = issue && issue.foundBy ? foundMeta(issue) : undefined;
    const ask = waiting.get(task.id);
    const working = WORKING.has(status);
    const checks = pull ? input.checks?.get(pull.id) : undefined;
    // An open pull request nothing is working on waits for the owner to merge it.
    const toMerge =
      pull?.status === 'open' &&
      !input.merging?.has(pull.id) &&
      !working &&
      !STOPPED.has(status) &&
      !PAUSED.has(status);
    const reason = ask
      ? ask.kind === 'question'
        ? 'Asked you a question'
        : ask.kind === 'control'
          ? 'Wants your go-ahead'
          : ask.kind === 'merge'
            ? 'Ready to merge'
            : ask.title || 'Waiting on you'
      : input.waitingForAnswer.has(task.id)
        ? 'Asked you a question'
        : input.controlRequests.has(task.id)
          ? 'Wants your go-ahead'
          : STOPPED.has(status)
            ? 'Stopped'
            : PAUSED.has(status)
              ? 'Paused'
              : toMerge
                ? checks?.failed
                  ? 'Checks failed'
                  : 'Ready to merge'
                : undefined;
    if (reason) {
      const mergeRow = reason === 'Ready to merge' || reason === 'Checks failed';
      rows.push({
        ...base,
        stage: 'needs-you',
        meta: [
          reason,
          hash,
          mergeRow && checks?.total && !checks.failed ? 'checks passed' : undefined,
          mergeRow && checks && !checks.total ? 'no checks yet' : undefined,
        ].filter(Boolean) as string[],
        at: latest(ask?.createdAt, at),
        // A task's pull request opens on the task's page, where it is merged, as everywhere else.
        link: { kind: 'task', id: task.id },
      });
      continue;
    }
    const computer = run?.workerId ? input.computerName(run.workerId) : undefined;
    const where =
      pull && input.merging?.has(pull.id)
        ? 'Merging'
        : status === 'queued'
          ? 'Queued'
          : status === 'preparing' || status === 'starting'
            ? computer
              ? `Starting on ${computer}`
              : 'Starting'
            : working
              ? computer
                ? `On ${computer} ${duration(String(run?.createdAt || at), now)}`
                : 'Working'
              : 'No pull request yet';
    // After who found it, the place reads as part of the sentence: "Found by X · on bazzite".
    const place = !found
      ? where
      : where.startsWith('On ') && computer
        ? `on ${computer}`
        : where.charAt(0).toLowerCase() + where.slice(1);
    rows.push({
      ...base,
      stage: 'running',
      meta: [found, place, hash].filter(Boolean) as string[],
      link: { kind: 'task', id: task.id },
    });
  }

  for (const pull of input.pulls) {
    if (usedPulls.has(pull.id) || pull.status === 'closed') continue;
    usedPulls.add(pull.id);
    const issue = input.issues.find(
      (row) => !usedIssues.has(row.id) && pull.issueIds?.includes(row.id),
    );
    if (issue) usedIssues.add(issue.id);
    const base = {
      id: `pull:${pull.id}`,
      title: pull.title || issue?.title || `Pull request #${pull.number}`,
      number: pull.number,
      link: { kind: 'pull' as const, id: pull.id },
    };
    if (pull.status === 'merged') {
      shipped.push({
        ...base,
        stage: 'shipped',
        meta: ['Merged', `#${pull.number}`],
        at: latest(pull.mergedAt, time(pull)),
      });
      continue;
    }
    const checks = input.checks?.get(pull.id);
    const operation = !!input.merging?.has(pull.id);
    rows.push({
      ...base,
      stage: operation ? 'running' : 'needs-you',
      meta: [
        operation ? 'Merging' : checks?.failed ? 'Checks failed' : 'Ready to merge',
        `#${pull.number}`,
        !operation && checks?.total && !checks.failed ? 'checks passed' : undefined,
      ].filter(Boolean) as string[],
      at: time(pull),
    });
  }

  for (const issue of input.issues) {
    if (usedIssues.has(issue.id)) continue;
    const base = {
      id: `issue:${issue.id}`,
      title: issue.title || `Issue #${issue.number}`,
      number: issue.number,
      link: { kind: 'issue' as const, id: issue.id },
      issue: issueOf(issue),
    };
    if ((issue.status || issue.state) === 'closed') {
      shipped.push({
        ...base,
        stage: 'shipped',
        meta: ['Closed', `#${issue.number}`],
        at: latest(issue.closedAt, time(issue)),
      });
      continue;
    }
    const found = foundByAgent(issue);
    rows.push({
      ...base,
      stage: found ? 'found' : 'up-next',
      meta: [
        found || issue.foundBy
          ? foundMeta(issue)
          : issue.author
            ? `Written by ${input.personName(String(issue.author))}`
            : 'Written down',
      ],
      // Ideas keep the time they were written down.
      at: String(issue.createdAt || time(issue)),
    });
  }

  const order = (a: WorkRow, b: WorkRow) =>
    OPEN_STAGES.indexOf(a.stage) - OPEN_STAGES.indexOf(b.stage) || b.at.localeCompare(a.at);
  rows.sort(order);
  shipped.sort((a, b) => b.at.localeCompare(a.at));
  return { rows, shipped, counts: { open: rows.length, shipped: shipped.length } };
}
