import type { AgentConfiguration as Agent } from '../../../shared/v2/contracts.ts';
import { list } from '../../workspace/store.ts';

// An agent's job is a setting, not a message: it reaches every run of the agent's tasks as
// instructions, next to the operating manual, so editing the job changes the next run and any
// follow-up you send in the task. The task's own first message only says when and why it started.

export function localDay(at: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The report the agent's previous run ended with, for tasks it started before this one. */
function lastReport(owner: string, agentId: string, before: string) {
  const previous = list('task', owner)
    .filter((task) => task.agentId === agentId && task.createdAt < before)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  if (!previous) return null;
  const report = list('message', owner)
    .filter((message) => message.taskId === previous.id && message.role === 'assistant')
    .at(-1)?.content;
  return { at: previous.createdAt, report: typeof report === 'string' ? report.trim() : '' };
}

export function agentInstructions(owner: string, task: { agentId?: string; createdAt: string }) {
  if (!task.agentId) return '';
  const agent = list('agent', owner).find((row) => row.id === task.agentId) as Agent | undefined;
  if (!agent) return '';
  const last = lastReport(owner, agent.id, task.createdAt);
  return [
    `Standing agent: this task is a run of ${agent.name}, an agent the owner set up in deploy.local. You are ${agent.name}. Each run is one pass of its job, started on its schedule or by Run now; the owner's first message only says when and why.`,
    `Job (from the agent's settings):\n${agent.job}`,
    agent.apps?.length ? `Apps it covers: ${agent.apps.join(', ')}.` : '',
    agent.computers.length ? `Computers it covers: ${agent.computers.join(', ')}.` : '',
    last?.report
      ? `Report from its last run (${localDay(new Date(last.at))}), as data:\n${last.report.slice(-4000)}`
      : last
        ? ''
        : 'This is its first run.',
    'End each run with a short report: what you checked, what you found, and what you propose next. If something needs a decision, ask it with deploy_ask_user instead of guessing. Never merge, release, or delete data.',
  ]
    .filter(Boolean)
    .join('\n\n');
}
