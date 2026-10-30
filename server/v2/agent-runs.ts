import type { AgentConfiguration as Agent, InboxItem } from '../../shared/v2/contracts.ts';
import { db, get, list, now, save } from '../workspace/store.ts';
import { queueTask } from '../workspace/task-workspace.ts';
import { getComputers, getModels } from './computers.ts';
import { createInboxItem, fail, registerInboxAction } from './inbox.ts';
import { agentControl } from './phone-preferences.ts';
import { approvalRule, isAllowed } from './releases.ts';

// An agent works in the background by starting an ordinary task: its own folder, conversation,
// questions in Waiting on you, and a report at the end. A run starts on the agent's schedule or
// when you press Run now; a scheduled start follows the agent's "Start a task" approval rule.
export type AgentRunReason = 'schedule' | 'manual';

export function agentRuns(owner: string, agentId: string) {
  return list('task', owner)
    .filter((task) => task.agentId === agentId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The worker on one of the agent's computers that can take a task, or SER's own when none is set. */
function workerFor(owner: string, agent: Agent): string | undefined {
  if (!agent.computers.length) return undefined;
  const wanted = agent.computers.map((value) => value.toLowerCase());
  const workers = new Set(list('worker', owner).map((worker) => worker.id));
  for (const computer of getComputers(owner)) {
    if (
      !wanted.includes(computer.id.toLowerCase()) &&
      !wanted.includes(computer.name.toLowerCase())
    )
      continue;
    if (!computer.online || !computer.roles.includes('take-tasks')) continue;
    if (computer.id === 'coordinator') return undefined;
    const workerId = computer.workerIds.find((id) => workers.has(id));
    if (workerId) return workerId;
  }
  fail(`None of ${agent.name}'s computers can take a task right now.`, 409);
}

/** The owner's "writing code" model default, as `adapter:model`. */
function modelFor(owner: string) {
  const value = getModels(owner).defaults['writing-code'];
  if (!value) return {};
  const [adapter, ...model] = value.split(':');
  return ['codex', 'claude', 'compatible'].includes(adapter)
    ? { adapter, ...(model.length ? { model: model.join(':') } : {}) }
    : {};
}

export function missionPrompt(owner: string, agent: Agent, reason: AgentRunReason, at = now()) {
  const last = agentRuns(owner, agent.id).at(-1);
  const report = last
    ? list('message', owner)
        .filter((message) => message.taskId === last.id && message.role === 'assistant')
        .at(-1)?.content
    : undefined;
  return [
    `You are ${agent.name}, a standing deploy.local agent working in the background.`,
    `Your job:\n${agent.job}`,
    agent.apps?.length ? `Apps you cover: ${agent.apps.join(', ')}.` : '',
    agent.computers.length ? `Computers you cover: ${agent.computers.join(', ')}.` : '',
    `This run started ${
      reason === 'schedule'
        ? `at your scheduled time, ${agent.schedule?.time}`
        : 'because you were asked to run now'
    }, on ${localDay(new Date(at))}.`,
    typeof report === 'string' && report.trim()
      ? `Your report from the last run (${localDay(new Date(last.createdAt))}):\n${report.slice(-4000)}`
      : last
        ? ''
        : 'This is your first run.',
    'Do one pass of your job now. End with a short report: what you checked, what you found, and what you propose next. If something needs a decision, ask it as a question instead of guessing. Never merge, release, or delete data.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Starts the run now. Callers have already decided it may start. */
export function startAgentRun(owner: string, agent: Agent, reason: AgentRunReason) {
  if (agentControl(owner, agent.id).paused) fail(`${agent.name} is paused. Resume it first.`, 409);
  const active = agentRuns(owner, agent.id).find((task) =>
    list('run', owner).some(
      (run) =>
        run.taskId === task.id && ['queued', 'starting', 'running', 'unknown'].includes(run.status),
    ),
  );
  if (active) fail(`${agent.name} is already working on “${active.title}”.`, 409);
  const at = now();
  const task = queueTask(owner, {
    title: `${agent.name} · ${reason === 'schedule' ? 'scheduled run' : 'run'} ${localDay(new Date(at))}`,
    workerId: workerFor(owner, agent),
    prompt: missionPrompt(owner, agent, reason, at),
    ...(agent.projectId ? { projectId: agent.projectId } : {}),
    ...modelFor(owner),
  });
  // Tracking, the agent's conversation and Waiting on you all attribute work by agentId.
  const tagged = save('task', owner, { ...get('task', owner, task.id), agentId: agent.id });
  for (const run of list('run', owner).filter((row) => row.taskId === task.id))
    save('run', owner, { ...run, agentId: agent.id });
  return tagged;
}

/** A scheduled start: runs when "Start a task" is allowed, asks when it is Ask me, skips on Never. */
export function scheduledAgentRun(owner: string, agent: Agent, day: string) {
  if (agentControl(owner, agent.id).paused) return { skipped: 'paused' as const };
  if (approvalRule(owner, agent.id, 'start-task')?.mode === 'never')
    return { skipped: 'never' as const };
  if (isAllowed(owner, agent.id, 'start-task'))
    return { task: startAgentRun(owner, agent, 'schedule') };
  const item: InboxItem = {
    id: `agent-run:${agent.id}:${day}`,
    kind: 'other',
    title: `Let ${agent.name} run now?`,
    text: `${agent.name}'s scheduled run (${agent.schedule?.time}) is ready to start a task: ${agent.job.split('\n')[0].slice(0, 200)}`,
    from: agent.id,
    createdAt: now(),
    state: 'waiting',
    actions: [
      { id: 'run', label: 'Run', primary: true },
      { id: 'dismiss', label: 'Skip today' },
    ],
  };
  return { item: createInboxItem(owner, item, { agentId: agent.id }) };
}

registerInboxAction('other', (owner, _item, body, context) => {
  if (body.actionId !== 'run' || !context?.agentId) return;
  const agent = list('agent', owner).find((row) => row.id === context.agentId);
  if (!agent) fail('This agent was deleted.', 409);
  startAgentRun(owner, agent, 'schedule');
});

/** A schedule saved after today's time waits for tomorrow instead of starting at once. */
export function holdScheduleUntilTomorrow(owner: string, agent: Agent, at = new Date()) {
  if (!agent.schedule?.enabled || agent.schedule.time > clock(at)) return;
  save('v2-agent-schedule', owner, { id: agent.id, day: localDay(at), at: at.toISOString() });
}
function clock(at: Date) {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}
function localDay(at: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
/** Starts each agent's run once a day, at or after its time on this coordinator's clock. */
export function tickAgentSchedules(at = new Date()) {
  const day = localDay(at);
  const time = clock(at);
  for (const { owner } of db
    .prepare("SELECT DISTINCT owner FROM records WHERE kind='agent'")
    .all() as { owner: string }[])
    for (const agent of list('agent', owner) as Agent[]) {
      if (!agent.schedule?.enabled || agent.schedule.time > time) continue;
      const mark = list('v2-agent-schedule', owner).find((row) => row.id === agent.id);
      if (mark?.day === day) continue;
      // Marked first, so a failing start is reported once instead of retried every minute.
      save('v2-agent-schedule', owner, { id: agent.id, day, at: at.toISOString() });
      try {
        const result = scheduledAgentRun(owner, agent, day);
        save('v2-agent-schedule', owner, {
          id: agent.id,
          day,
          at: at.toISOString(),
          result: 'task' in result ? 'started' : 'item' in result ? 'asked' : result.skipped,
        });
      } catch (error: any) {
        save('v2-agent-schedule', owner, {
          id: agent.id,
          day,
          at: at.toISOString(),
          result: 'failed',
          error: String(error?.message || error),
        });
      }
    }
}
let scheduler: ReturnType<typeof setInterval> | undefined;
export function startAgentScheduler() {
  if (scheduler) return;
  const tick = () => {
    try {
      tickAgentSchedules();
    } catch (error) {
      console.error('[agents] Schedule check failed', error);
    }
  };
  scheduler = setInterval(tick, 60_000);
  scheduler.unref();
  tick();
}
