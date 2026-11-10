import {
  checkAttempts,
  resultUnreadable,
  unknownResultMessage,
} from '../../../../../shared/check-attempts.ts';
import type { TaskCheck, TaskCheckpoint, TaskDiff, TaskView } from './types.ts';

export function latestChecks(checks: TaskCheck[]) {
  return checkAttempts(
    checks,
    (check) => check.label || check.name || check.command || check.id,
  ).map(({ latest }) => latest);
}
/** A frozen publication keeps its result; only matching records may supply its log and timing. */
export function checkDetails(checks: TaskCheck[], checkpoints: TaskCheckpoint[]) {
  const details = new Map(
    checkpoints.flatMap((checkpoint) => checkpoint.checks).map((check) => [check.id, check]),
  );
  return checks.map((check) => {
    const detail = details.get(check.id);
    if (!detail || detail.status !== check.status) return check;
    return {
      ...detail,
      ...check,
      name: check.name || detail.name,
      output: check.output || detail.output,
      startedAt: check.startedAt || detail.startedAt,
      finishedAt: check.finishedAt || detail.finishedAt,
    };
  });
}
export function taskCheckpoints(view: TaskView, pullChecks: TaskCheck[], headCommit?: string) {
  const history = view.checkpoints || [];
  const checkpoint = history.at(-1);
  const pull = view.pulls.at(-1);
  const published = !!headCommit && checkpoint?.commit === headCommit;
  const checks = checkpoint
    ? latestChecks([...checkDetails(published ? pullChecks : [], history), ...checkpoint.checks])
    : pull
      ? pullChecks
      : latestChecks(view.checks);
  return {
    checkpoint,
    checks,
    earlier: history
      .filter((item) => checkpoint && item.number < checkpoint.number && item.checks.length)
      .reverse(),
    // The publication receipt binds the checkpoint digest to a commit, never just a branch.
    headChecks: pull && checkpoint && !published ? [] : checks,
  };
}
export function taskUpdatedAt(view: TaskView, checks: TaskCheck[]) {
  return [
    view.task.updatedAt,
    view.run?.updatedAt,
    view.checkpoint?.at,
    view.pulls.at(-1)?.updatedAt,
    ...checks.map((check) => check.finishedAt || check.completedAt || check.updatedAt),
  ]
    .filter((value): value is string => !!value && Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .at(-1);
}
export const checkPassed = (check: TaskCheck) => ['passed', 'succeeded'].includes(check.status);
export function checkResult(check: TaskCheck) {
  if (resultUnreadable(check)) return unknownResultMessage;
  if (checkPassed(check)) return 'Passed';
  return (
    (
      {
        failed: 'Failed',
        running: 'Running',
        queued: 'Queued',
        cancelled: 'Cancelled',
        interrupted: 'Interrupted',
        unknown: 'Result unknown',
      } as Record<string, string>
    )[check.status] || 'Result unknown'
  );
}
export function checkSummary(checks: TaskCheck[]) {
  return checks.length
    ? `${checks.filter(checkPassed).length} of ${checks.length} passed`
    : 'No checks yet';
}
export function checkDuration(check: TaskCheck) {
  const end = check.finishedAt || check.completedAt;
  const start = check.startedAt;
  const ms = check.durationMs ?? (start && end ? Date.parse(end) - Date.parse(start) : NaN);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return ms < 60000
    ? `${Math.round(ms / 1000)} s`
    : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
}
/**
 * The task's state in the header. `checks` ran on the pull request's head; `latest` are the latest
 * checkpoint's, which may be newer work. Only a head whose checks all passed is ready to merge, and
 * a failure on either is never called ready.
 */
export const designCheckWaiting = (view: TaskView) =>
  !!view.designCheck && ['waiting', 'differs'].includes(view.designCheck.state);

/** The banner for a task that waits for a computer with the programs it said it needs. */
export function waitingForComputer(needs: TaskView['needs']) {
  if (!needs?.waiting) return null;
  const tools = needs.tools.join(', ');
  const all = (has: Record<string, boolean | null>, value: boolean) =>
    value
      ? needs.tools.every((tool) => has[tool] === true)
      : needs.tools.some((tool) => has[tool] === false);
  const ready = needs.asked.filter((computer) => all(computer.has, true));
  const offline = ready.filter((computer) => !computer.online).map((computer) => computer.name);
  const names =
    offline.length > 1
      ? `${offline.slice(0, -1).join(', ')} and ${offline.at(-1)}`
      : (offline[0] ?? '');
  const detail = offline.length
    ? `${names} ${offline.length === 1 ? 'has' : 'have'} ${tools} and ${offline.length === 1 ? 'is' : 'are'} offline; the task starts there when ${offline.length === 1 ? 'it is' : 'one is'} back.`
    : needs.asked.length
      ? `None of your computers has ${tools} yet.`
      : 'No computer has answered yet.';
  const answers = needs.asked.map(
    (computer) =>
      `${computer.name} ${all(computer.has, true) ? `yes${computer.online ? '' : ', offline'}` : all(computer.has, false) ? 'no' : 'not answered'}`,
  );
  return {
    title: `Waiting for a computer with ${tools}`,
    detail: `deploy.local asked your computers. ${detail} Nothing has run yet.`,
    asked: [
      `The task said it needs ${tools}${needs.why ? `: ${needs.why.replace(/\.$/, '')}` : ''}.`,
      needs.asked.length
        ? `Asked ${needs.asked.length} computer${needs.asked.length === 1 ? '' : 's'}`
        : '',
      ...answers,
    ]
      .filter(Boolean)
      .join(' · '),
  };
}

export function taskStatus(
  view: TaskView,
  diff: TaskDiff | null,
  checks: TaskCheck[],
  latest: TaskCheck[] = [],
) {
  const pull = view.pulls.at(-1);
  const status = view.run?.status || view.task.status;
  const passed = checks.length > 0 && checks.every(checkPassed);
  const failedOn = [checks, latest].find((set) => set.some((check) => check.status === 'failed'));
  const target = pull?.targetBranch || 'main';
  if (pull?.status === 'merged')
    return { label: 'Merged', detail: undefined, icon: 'check' as const };
  if (pull?.status === 'closed')
    return { label: 'Pull request closed', detail: undefined, icon: 'clock' as const };
  if (pull?.status === 'open' && diff?.mergeable)
    return failedOn
      ? {
          label: 'Checks failed',
          detail: `${checkSummary(failedOn)}, no conflicts with ${target}`,
          icon: 'close' as const,
        }
      : passed
        ? {
            label: designCheckWaiting(view) ? 'Design not checked' : 'Ready to merge',
            detail: `Checks passed, no conflicts with ${target}`,
            icon: designCheckWaiting(view) ? ('clock' as const) : ('check' as const),
          }
        : {
            label: 'Not checked',
            detail: `No checks on this version, no conflicts with ${target}`,
            icon: 'clock' as const,
          };
  if (pull && diff?.conflicts?.length)
    return { label: 'Changes needed', detail: `Conflicts with ${target}`, icon: 'close' as const };
  if (pull)
    return {
      label: 'In review',
      detail: checks.length ? checkSummary(checks) : undefined,
      icon: 'clock' as const,
    };
  if (['queued', 'starting', 'running', 'preparing', 'checking'].includes(status))
    return {
      label: 'Working',
      detail: !view.checkpoint
        ? 'On its first checkpoint, no pull request yet'
        : `Checkpoint ${view.checkpoint.number}, no pull request yet`,
      icon: 'running' as const,
    };
  return {
    label:
      status === 'failed'
        ? 'Stopped'
        : ['unknown', 'stalled', 'interrupted', 'blocked'].includes(status)
          ? 'Paused'
          : 'No pull request yet',
    detail: undefined,
    icon: 'clock' as const,
  };
}

/** Hide the generated checks section in read mode; editing keeps the original Markdown intact. */
export function descriptionWithoutChecks(body: string) {
  let hidden = false;
  let fenced = false;
  let depth = 0;
  return body
    .split('\n')
    .filter((line) => {
      if (/^\s*```|^\s*~~~/.test(line)) fenced = !fenced;
      const heading = !fenced && line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
      if (heading) {
        if (hidden && heading[1].length <= depth) hidden = false;
        if (/^Checks$/i.test(heading[2])) {
          hidden = true;
          depth = heading[1].length;
        }
      }
      return !hidden;
    })
    .join('\n')
    .trim();
}

export function fileTree(paths: string[]) {
  const rows: { path: string; label: string; depth: number; folder: boolean }[] = [];
  const seen = new Set<string>();
  for (const path of [...paths].sort()) {
    const parts = path.split('/');
    parts.forEach((label, depth) => {
      const key = parts.slice(0, depth + 1).join('/');
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({ path: key, label, depth, folder: depth < parts.length - 1 });
    });
  }
  return rows;
}
