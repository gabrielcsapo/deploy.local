import type {
  SelfUpdateRun,
  SelfUpdateStatus,
  SelfUpdateStep,
} from '../../../../../shared/v2/contracts';
import type { IconName } from '@/components/ui';

export const short = (sha: string) => sha.slice(0, 7);
type Supported = Extract<SelfUpdateStatus, { supported: true }>;
export type SelfUpdateView =
  | { kind: 'available'; status: Supported }
  | { kind: 'running' | 'failed'; status: Supported; run: SelfUpdateRun };

/** What the coordinator's own update needs from its administrator, if anything. */
export function selfUpdateView(status?: SelfUpdateStatus): SelfUpdateView | null {
  if (!status?.supported) return null;
  const { run } = status;
  if (run?.state === 'running') return { kind: 'running', status, run };
  if (run?.state === 'failed' && status.running !== run.to && status.ahead > 0)
    return { kind: 'failed', status, run };
  return status.ahead > 0 ? { kind: 'available', status } : null;
}

export function minutes(ms: number) {
  const count = Math.max(1, Math.round(ms / 60000));
  return `${count} ${count === 1 ? 'minute' : 'minutes'}`;
}
/** The short form the boards use in running text: "5 min". */
export const min = (ms: number) => `${Math.max(1, Math.round(ms / 60000))} min`;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
export const changeCount = (count: number) => plural(count, 'change');

export function sidebarRow(view: SelfUpdateView) {
  if (view.kind === 'running')
    return { icon: 'running', iconClass: 'dl-run', label: 'Updating deploy.local' } as const;
  if (view.kind === 'failed')
    return { icon: 'failed', iconClass: 'dl-fail', label: 'Update failed' } as const;
  return { icon: 'update', iconClass: '', label: 'Update available' } as const;
}

export function pageMeta(view: SelfUpdateView) {
  const { status } = view;
  if (view.kind === 'running')
    return `Updating ${status.computer} from ${short(view.run.from)} to ${short(view.run.to)}`;
  if (view.kind === 'failed') return `${status.computer} is still on ${short(status.running)}`;
  return `${status.computer} runs ${short(status.running)} · main is ${changeCount(status.ahead)} ahead`;
}

const words: Record<SelfUpdateStep['id'], Record<'waiting' | 'running' | 'done', string>> = {
  prepare: {
    waiting: 'Prepare the new build',
    running: 'Preparing the new build',
    done: 'Prepared the new build',
  },
  backup: {
    waiting: 'Back up the databases',
    running: 'Backing up the databases',
    done: 'Backed up the databases',
  },
  restart: {
    waiting: 'Restart into the new build',
    running: 'Restarting into the new build',
    done: 'Restarted into the new build',
  },
  check: { waiting: 'Check it is healthy', running: 'Checking it is healthy', done: 'Healthy' },
};
const icons: Record<SelfUpdateStep['state'], { icon: IconName; iconClass?: string }> = {
  waiting: { icon: 'clock' },
  skipped: { icon: 'clock' },
  running: { icon: 'running', iconClass: 'dl-run' },
  done: { icon: 'check', iconClass: 'dl-ok' },
  failed: { icon: 'failed', iconClass: 'dl-fail' },
};
/** The four steps, worded for where they stand; planned steps say what they will do. */
export function updateSteps(
  steps: Pick<SelfUpdateStep, 'id' | 'state' | 'detail'>[],
  status: Supported,
  from = status.running,
) {
  const planned: Record<SelfUpdateStep['id'], string> = {
    prepare: `install, typecheck, build and tests · about ${min(status.estimateMs)} · nothing changes yet`,
    backup: 'deploy.db and workspace.db',
    restart: 'pages reconnect within a few seconds',
    check: `if not, ${status.computer} goes back to ${short(from)} on its own`,
  };
  return steps.map((step) => ({
    text: words[step.id][
      step.state === 'running' || step.state === 'done' ? step.state : 'waiting'
    ],
    detail: step.detail || planned[step.id],
    ...icons[step.state],
  }));
}
export const plannedSteps = (status: Supported) =>
  updateSteps(
    (['prepare', 'backup', 'restart', 'check'] as const).map((id) => ({ id, state: 'waiting' })),
    status,
  );

export function runningNotice(
  run: SelfUpdateRun,
  status: Supported,
  you: string,
  now = Date.now(),
) {
  const elapsed = now - Date.parse(run.startedAt);
  const ago = elapsed < 60_000 ? 'just now' : `${min(elapsed)} ago`;
  const left = status.estimateMs - elapsed;
  const who = run.startedBy === you ? 'You' : run.startedBy;
  return `${who} started this ${ago}. ${
    left > 30_000 ? `About ${min(left)} left.` : 'Taking a little longer than usual.'
  } This page reconnects by itself when ${status.computer} restarts.`;
}
export function failedNotice(run: SelfUpdateRun, status: Supported) {
  const error = run.error || `The update to ${short(run.to)} did not finish.`;
  return run.rolledBack
    ? error
    : `${error} ${status.computer} is still running ${short(status.running)}.`;
}
