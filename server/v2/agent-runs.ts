import type {
  AgentConfiguration as Agent,
  InboxItem,
  LooksAfterItem,
} from '../../shared/v2/contracts.ts';
import { db, get, list, now, save, events } from '../workspace/store.ts';
import { queueTask } from '../workspace/task-workspace.ts';
import { getModels } from './computers.ts';
import { onlineTaskWorker } from './task-computer.ts';
import { createInboxItem, registerInboxAction } from './inbox.ts';
import { fail } from '../kernel/errors.ts';
import { agentControl } from './phone-preferences.ts';
import { migrateAgent, nextItemAt, itemProjects } from './agent-foundation.ts';
import { localDay } from './agent-instructions.ts';
import { approvalRule, isAllowed } from './releases.ts';

// An agent works in the background by starting an ordinary task: its own folder, conversation,
// questions in Waiting on you, and a report at the end. A run starts on the agent's schedule or
// when you press Run now; a scheduled start follows the agent's "Start a task" approval rule.
export type AgentRunReason = 'schedule' | 'manual';

export function agentRuns(owner: string, agentId: string, itemId?: string) {
  return list('task', owner)
    .filter((task) => task.agentId === agentId && (!itemId || task.agentItemId === itemId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * A worker that can take the run: on one of the agent's computers when it names any, otherwise on
 * any computer that takes tasks, SER first. Workers only claim runs addressed to them, so a run is
 * always addressed to a real worker, preferring one with the run's provider connected.
 */
function workerFor(owner: string, agent: Agent, adapter = 'codex'): string {
  const wanted = agent.computers;
  const workerId = onlineTaskWorker(owner, { adapter, wanted });
  if (!workerId)
    fail(
      wanted.length
        ? `None of ${agent.name}'s computers can take a task right now.`
        : 'No computer can take a task right now. Turn on Take tasks for one in Computers.',
      409,
    );
  return workerId;
}

/** The owner's "writing code" model default, as `adapter:model`. */
function modelFor(owner: string): { adapter?: string; model?: string } {
  const value = getModels(owner).defaults['writing-code'];
  if (!value) return {};
  const [adapter, ...model] = value.split(':');
  return ['codex', 'claude', 'compatible'].includes(adapter)
    ? { adapter, ...(model.length ? { model: model.join(':') } : {}) }
    : {};
}

/** The task's first message. The agent's job reaches the run as instructions, not here. */
export function runMessage(
  agent: Agent,
  reason: AgentRunReason,
  at = now(),
  item?: LooksAfterItem,
) {
  const day = localDay(new Date(at));
  return reason === 'schedule'
    ? `Run your job now. Started at your scheduled time, ${item?.when.time ?? agent.schedule?.time}, on ${day}.`
    : `Run your job now. Started with Run now on ${day}.`;
}

/** Starts the run now. Callers have already decided it may start. */
export function startAgentRun(
  owner: string,
  agent: Agent,
  reason: AgentRunReason,
  item?: LooksAfterItem,
) {
  if (agentControl(owner, agent.id).paused) fail(`${agent.name} is paused. Resume it first.`, 409);
  if (
    item &&
    (agent.projectId || typeof item.where !== 'string') &&
    !itemProjects(owner, agent, item).length
  )
    fail('This item has no projects within the agent’s access.', 409);
  const active = agentRuns(owner, agent.id).find((task) =>
    list('run', owner).some(
      (run) =>
        run.taskId === task.id && ['queued', 'starting', 'running', 'unknown'].includes(run.status),
    ),
  );
  if (active) fail(`${agent.name} is already working on “${active.title}”.`, 409);
  const at = now();
  const model = modelFor(owner);
  const task = queueTask(owner, {
    title: `${agent.name} · ${reason === 'schedule' ? 'scheduled run' : 'run'} ${localDay(new Date(at))}`,
    workerId: workerFor(owner, agent, model.adapter),
    prompt: item
      ? `${item.what}\n\nWhere (within granted access): ${
          itemProjects(owner, agent, item)
            .map((p) => `${p.name} (${p.id})`)
            .join(', ') || 'No accessible projects'
        }.\nBring a ${item.brings.replaceAll('-', ' ')}.\n\n${runMessage(agent, reason, at, item)}`
      : runMessage(agent, reason, at),
    ...((item ? itemProjects(owner, agent, item)[0]?.id : agent.projectId)
      ? { projectId: item ? itemProjects(owner, agent, item)[0]?.id : agent.projectId }
      : {}),
    ...model,
  });
  // Tracking, the agent's conversation and Waiting on you all attribute work by agentId.
  const tagged = save('task', owner, {
    ...get('task', owner, task.id),
    agentId: agent.id,
    ...(item ? { agentItemId: item.id } : {}),
  });
  for (const run of list('run', owner).filter((row) => row.taskId === task.id))
    save('run', owner, { ...run, agentId: agent.id, ...(item ? { agentItemId: item.id } : {}) });
  return tagged;
}

/** A scheduled start: runs when "Start a task" is allowed, asks when it is Ask me, skips on Never. */
export function scheduledAgentRun(
  owner: string,
  agent: Agent,
  day: string,
  looksAfter?: LooksAfterItem,
) {
  if (agentControl(owner, agent.id).paused) return { skipped: 'paused' as const };
  if (
    looksAfter &&
    (agent.projectId || typeof looksAfter.where !== 'string') &&
    !itemProjects(owner, agent, looksAfter).length
  )
    return { skipped: 'access' as const };
  if (approvalRule(owner, agent.id, 'start-task')?.mode === 'never')
    return { skipped: 'never' as const };
  if (isAllowed(owner, agent.id, 'start-task'))
    return { task: startAgentRun(owner, agent, 'schedule', looksAfter) };
  const item: InboxItem = {
    id: `agent-run:${agent.id}:${looksAfter?.id ?? 'legacy'}:${day}`,
    kind: 'other',
    title: `Let ${agent.name} run now?`,
    text: `${agent.name}'s scheduled run (${looksAfter?.when.time ?? agent.schedule?.time}) is ready to start a task: ${(looksAfter?.what ?? agent.job).split('\n')[0].slice(0, 200)}`,
    from: agent.id,
    createdAt: now(),
    state: 'waiting',
    actions: [
      { id: 'run', label: 'Run', primary: true },
      { id: 'dismiss', label: 'Skip today' },
    ],
  };
  return {
    item: createInboxItem(owner, item, {
      agentId: agent.id,
      agentItemId: looksAfter?.id,
      confirmedAt: looksAfter?.confirmedAt,
    }),
  };
}

registerInboxAction('other', (owner, _item, body, context) => {
  if (body.actionId !== 'run' || !context?.agentId) return;
  const agent = list('agent', owner).find((row) => row.id === context.agentId);
  if (!agent) fail('This agent was deleted.', 409);
  const item = agent.looksAfter?.find((i: LooksAfterItem) => i.id === context.agentItemId);
  if (context.agentItemId && (!item?.confirmedAt || item.confirmedAt !== context.confirmedAt))
    fail('This item changed. Confirm it again first.', 409);
  if (approvalRule(owner, agent.id, 'start-task')?.mode === 'never')
    fail('This action is now forbidden.', 409);
  startAgentRun(owner, agent, 'schedule', item);
});

/** A schedule saved after today's time waits for tomorrow instead of starting at once. */
export function holdScheduleUntilTomorrow(owner: string, agent: Agent, at = new Date()) {
  if (!agent.schedule?.enabled || agent.schedule.time > clock(at)) return;
  save('v2-agent-schedule', owner, { id: agent.id, day: localDay(at), at: at.toISOString() });
}
function clock(at: Date) {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}
/** Starts each agent's run once a day, at or after its time on this coordinator's clock. */
export function tickAgentSchedules(at = new Date()) {
  for (const { owner } of db
    .prepare("SELECT DISTINCT owner FROM records WHERE kind='agent'")
    .all() as { owner: string }[]) {
    for (const row of list('agent', owner)) {
      const agent = migrateAgent(owner, row);
      for (const item of agent.looksAfter ?? []) {
        if (!item.confirmedAt) continue;
        const key = `${agent.id}:${item.id}`;
        const mark = list('v2-agent-schedule', owner).find((m) => m.id === key);
        // Migrated schedules retain today's mark so upgrading cannot run twice.
        const legacy =
          item.id === `legacy-${agent.id}`
            ? list('v2-agent-schedule', owner).find((m) => m.id === agent.id)
            : undefined;
        const local = new Intl.DateTimeFormat('en-GB', {
          timeZone: item.when.timezone,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hourCycle: 'h23',
        }).formatToParts(at);
        const part = (unit: string) => Number(local.find((p) => p.type === unit)?.value ?? 0);
        const midnight = new Date(
          at.getTime() -
            ((part('hour') * 60 + part('minute')) * 60 + part('second')) * 1000 -
            at.getMilliseconds() -
            1,
        );
        const from = new Date(
          Math.max(
            Date.parse(item.confirmedAt),
            Date.parse(mark?.at ?? legacy?.at ?? midnight.toISOString()),
          ),
        );
        let due = nextItemAt(item, from);
        let cursor = mark?.cursor ?? 0;
        if (item.when.every === 'change') {
          const projects = new Set(itemProjects(owner, agent, item).map((p) => p.id));
          let changed = false;
          for (;;) {
            const page = events(owner, cursor);
            for (const e of page) {
              cursor = e.cursor;
              const task = e.taskId
                ? list('task', owner).find((t) => t.id === e.taskId)
                : undefined;
              if (
                Date.parse(e.createdAt) > from.getTime() &&
                [
                  'project.updated',
                  'repository.updated',
                  'pull-request.updated',
                  'release.completed',
                  'task.committed',
                  'task.merged',
                ].includes(e.type) &&
                projects.has(e.payload.projectId ?? task?.projectId ?? e.payload.id) &&
                task?.agentItemId !== item.id
              )
                changed = true;
            }
            if (page.length < 1000) break;
          }
          if (!changed) {
            save('v2-agent-schedule', owner, { ...mark, id: key, cursor, at: from.toISOString() });
            continue;
          }
          due = at.toISOString();
        }
        if (!due || Date.parse(due) > at.getTime()) continue;
        // Another item may still be working. Keep this occurrence due until it can start.
        if (
          agentRuns(owner, agent.id).some((task) =>
            list('run', owner).some(
              (run) =>
                run.taskId === task.id &&
                ['queued', 'starting', 'running', 'unknown'].includes(run.status),
            ),
          )
        )
          continue;
        const stamp = { id: key, day: localDay(at), at: at.toISOString(), cursor };
        save('v2-agent-schedule', owner, stamp);
        try {
          const result = scheduledAgentRun(owner, agent, due, item);
          save('v2-agent-schedule', owner, {
            ...stamp,
            result: 'task' in result ? 'started' : 'item' in result ? 'asked' : result.skipped,
          });
        } catch (error: any) {
          save('v2-agent-schedule', owner, {
            ...stamp,
            result: 'failed',
            error: String(error?.message || error),
          });
        }
      }
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
