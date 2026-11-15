import { hostname } from 'node:os';
import { editWatermark, editWatermarks } from './activity.ts';
import {
  activityEvents,
  list,
  listCheckpointMetadata,
  checkpointInfo,
} from '../../workspace/store.ts';
import { currentTaskBranch } from './follow-up.ts';
import {
  commandItem,
  commandText,
  scrubCheckText,
  verificationRun,
} from './workspace-verification.ts';
import { verificationResult } from './verification-output.ts';
import {
  type CheckLabelContext,
  checkCommandLabel,
  checkCommandText,
} from '../../../shared/check-label.ts';

type Row = Record<string, any>;
export const workspaceChecksLimit = 30;

/** How much of the deciding output a check record keeps. */
const evidenceChars = 500;

/** Fold lifecycle events into one result per verification command. An unpiped command's exit
 * code decides it; a piped one hides it, so the result is read from the output tail and only
 * the few lines that decided it are kept (see `verificationResult`). */
export function workspaceChecks(
  events: Row[],
  runs: Row[],
  workers: Row[],
  task: CheckLabelContext = {},
): Row[] {
  const items = new Map<string, Row>();
  const watermarks = editWatermarks(events);
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    const item = event.payload?.item;
    if (!item?.id || !event.runId) continue;
    const key = `${event.runId}:${item.id}`;
    const previous = items.get(key);
    if (!previous && !commandItem(item)) continue;
    items.set(key, {
      ...previous,
      ...item,
      runId: event.runId,
      startedAt: previous?.startedAt ?? (event.type === 'item.started' ? event.createdAt : null),
      // Include the command itself for a completion-only lifecycle. Verification doesn't move
      // the watermark; any edit or unknown command during it does, and makes it earlier.
      watermark: previous ? previous.watermark : watermarks[index],
      finished: event.type === 'item.completed',
      updatedAt: event.createdAt,
      order: index,
    });
  }
  const collapsed = new Map<string, Row>();
  for (const [id, item] of [...items].sort((a, b) => a[1].order - b[1].order)) {
    const raw = commandText(item);
    const run = item.finished ? verificationRun(raw) : null;
    const result = run && verificationResult(run, item);
    if (!result) continue;
    const workerId = runs.find((row) => row.id === item.runId)?.workerId ?? null;
    const computerName =
      workerId === 'local' ? hostname() : workers.find((w) => w.id === workerId)?.name;
    const scrubbed = scrubCheckText(raw).replace(/\s+/g, ' ').trim();
    const command = checkCommandText(scrubbed, task).slice(0, 1000);
    // The headline a reviewer reads; the command above stays beside it in full.
    const label = checkCommandLabel(scrubbed, task);
    const duration = item.duration_ms ?? Date.parse(item.updatedAt) - Date.parse(item.startedAt);
    // Two runs that differ only in their plumbing are attempts at one check, so the headline
    // they share is what collapses them: a rerun without a tail replaces the piped attempt.
    const key = JSON.stringify([workerId, label || command, item.watermark]);
    const prior = collapsed.get(key);
    collapsed.delete(key);
    collapsed.set(key, {
      id: `workspace:${id}`,
      source: 'workspace',
      command,
      label,
      workerId,
      sourceLabel: `Ran in the task workspace${computerName ? ` on ${scrubCheckText(computerName).slice(0, 200)}` : ''}`,
      watermark: item.watermark,
      exitCode: Number.isInteger(item.exit_code) ? item.exit_code : null,
      status: result.status,
      // A pipe hid the exit code, so the result was read from the output: say so wherever it
      // is shown, and keep the lines it was read from.
      piped: run.piped,
      evidence: scrubCheckText(result.evidence).slice(0, evidenceChars),
      durationMs: Number.isFinite(duration) && duration >= 0 ? duration : null,
      output: '',
      createdAt: item.startedAt ?? item.updatedAt,
      updatedAt: item.updatedAt,
      attempts: (prior?.attempts ?? 0) + 1,
    });
  }
  return [...collapsed.values()].slice(-workspaceChecksLimit);
}

export function taskWorkspaceChecks(
  owner: string,
  taskId: string,
  events = activityEvents(owner, taskId),
) {
  // The task's own workspace roots are what make a command's paths repository-relative.
  const task = list('task', owner).find((row) => row.id === taskId);
  return workspaceChecks(
    events,
    list('run', owner).filter((r) => r.taskId === taskId),
    list('worker', owner),
    { ...task, id: taskId },
  );
}

/** Freeze check provenance into the publication receipt, rather than consulting a task's live
 * watermark when a reviewer opens an old commit. Receipts replay these same bounded rows. */
export function publishedTaskChecks(
  owner: string,
  task: Row,
  checkpoint: Row | null,
  commit: string,
  branch = currentTaskBranch(task),
): Row[] {
  const cutoff = checkpoint?.createdAt ?? new Date().toISOString();
  const events = activityEvents(owner, task.id).filter((event) => event.createdAt <= cutoff);
  const watermark = editWatermark(events);
  const checks =
    task.workerId && task.workerId !== 'local'
      ? (list('remote-diff', owner).find((row) => row.id === task.id)?.checks ?? [])
      : list('check', owner).filter((row) => row.taskId === task.id);
  const jobs = list('job', owner).filter((row) => row.taskId === task.id);
  const workers = list('worker', owner);
  const rows = [
    ...checks.map((row: Row) => ({
      ...row,
      source: 'coordinator',
      sourceLabel: 'Ran as a coordinator check',
    })),
    ...jobs.map((row) => ({
      ...row,
      source: 'job',
      sourceLabel: `Ran as a recorded job${workers.find((w) => w.id === row.workerId)?.name ? ` on ${workers.find((w) => w.id === row.workerId)!.name}` : ''}`,
    })),
    ...taskWorkspaceChecks(owner, task.id, events),
  ];
  const history = new Map<string, Row>(
    (task.publishedCheckRuns ?? []).map((row: Row) => [row.id, row]),
  );
  for (const row of rows) {
    // Jobs normally run after capture. Their digest proves the version regardless of time;
    // only streamed workspace activity needs the checkpoint's event cutoff above.
    const current =
      row.checkpointId || row.digest != null
        ? checkpointInfo(checkpoint).digest != null &&
          row.digest === checkpointInfo(checkpoint).digest
        : 'watermark' in row && row.watermark === watermark;
    const previous = history.get(row.id);
    const scrubbed = scrubCheckText(String(row.command ?? row.name ?? 'Recorded check'));
    // Explicitly select safe, bounded presentation fields; no raw args, environments or errors.
    history.set(row.id, {
      id: row.id,
      source: row.source,
      sourceLabel: scrubCheckText(row.sourceLabel).slice(0, 250),
      command: checkCommandText(scrubbed, task).slice(0, 1000),
      // What the pull request's surfaces put in the headline: the checks, without the plumbing
      // or the worker directory the agent's shell started in.
      label: (row.label ? scrubCheckText(String(row.label)) : checkCommandLabel(scrubbed, task))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300),
      status: row.status,
      exitCode: row.exitCode ?? null,
      piped: row.piped === true,
      evidence: scrubCheckText(String(row.evidence ?? '')).slice(0, evidenceChars),
      durationMs: row.durationMs ?? null,
      output: '',
      attempts: row.attempts ?? 1,
      createdAt: row.createdAt ?? row.updatedAt ?? cutoff,
      updatedAt: row.updatedAt,
      commit: current ? commit : (previous?.commit ?? null),
      sourceBranch: current ? branch : (previous?.sourceBranch ?? branch),
      watermark: row.watermark ?? null,
    });
  }
  return [...history.values()].slice(-90);
}

/** Older publications can use their saved checkpoint boundary too. Never derive against the
 * live workspace, or attach a follow-up branch's runs to its already merged predecessor. */
export function pullTaskChecks(owner: string, pull: Row): Row[] {
  return list('task', owner)
    .filter((task) => task.projectId === pull.projectId && pull.taskIds?.includes(task.id))
    .flatMap((task) => {
      let runs = task.publishedCheckRuns;
      if (!runs && task.publishedCommit && task.publishedCheckpointId) {
        const checkpoint = listCheckpointMetadata(owner, task.id).find(
          (row) => row.id === task.publishedCheckpointId && row.taskId === task.id,
        );
        if (checkpoint) runs = publishedTaskChecks(owner, task, checkpoint, task.publishedCommit);
      }
      return (runs ?? []).filter((run: Row) => run.sourceBranch === pull.sourceBranch);
    })
    .slice(-90);
}
