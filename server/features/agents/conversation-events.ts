import { mapMediaEvent } from './media-event.ts';
import type { ConversationEvent, WorkStep } from '../../../shared/v2/contracts.ts';
import { agentId } from '../decisions/inbox.ts';
import { jobStep, toolStep, type ToolItem } from './work-steps.ts';

/**
 * What a mapper remembers between rows. A tool result names neither its tool nor its arguments,
 * and a finished job event carries only its id, so both are read from what came before.
 */
export type ConversationContext = {
  calls?: Map<string, ToolItem>;
  job?: (id: string) => Record<string, any> | undefined;
  computer?: (id: string) => string | undefined;
};

const ENDED_RUN = new Set(['interrupted', 'failed', 'cancelled', 'stopped']);

const workIcons = new Map<string, WorkStep['icon']>([
  ['command_execution', 'terminal'],
  ['file_change', 'edit'],
  ['web_search', 'search'],
  ['tool_call', 'pulse'],
  ['tool_result', 'pulse'],
  ['mcp_tool_call', 'pulse'],
]);

export function mapConversationEvent(
  row: any,
  run?: any,
  context: ConversationContext = {},
): ConversationEvent | undefined {
  const media = mapMediaEvent(row);
  if (media) return media;
  const payload = row.payload ?? {};
  if (
    row.type === 'v2.conversation' &&
    payload.event?.kind === 'decision' &&
    ['id', 'at', 'inboxItemId'].every((key) => typeof payload.event[key] === 'string')
  )
    return {
      kind: 'decision',
      id: payload.event.id,
      at: payload.event.at,
      inboxItemId: payload.event.inboxItemId,
    };
  const at = typeof payload.createdAt === 'string' ? payload.createdAt : row.createdAt;
  const id =
    typeof payload.id === 'string'
      ? payload.id
      : typeof payload.providerItemId === 'string'
        ? `${row.runId}:item:${payload.providerItemId}`
        : `event:${row.cursor}`;
  // A deploy is shown as a step; its stored Markdown summary would repeat it as a reply.
  if (
    row.type === 'message' &&
    typeof payload.id === 'string' &&
    payload.id.startsWith('deployment:')
  )
    return;
  if (row.type === 'message' && typeof payload.content === 'string') {
    if (payload.role === 'user')
      return {
        kind: 'you',
        id,
        at,
        text: payload.content,
        attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
        ...(typeof run?.model === 'string' ? { model: run.model } : {}),
      };
    if (payload.role === 'assistant')
      return {
        kind: 'reply',
        id,
        at,
        agent: agentId(run),
        paragraphs: payload.content.split(/\n\s*\n/),
      };
  }
  if (row.type === 'question.requested' && typeof payload.id === 'string')
    return {
      kind: 'decision',
      id: 'decision:question:' + payload.id,
      at,
      inboxItemId: 'question:' + payload.id,
    };
  if (row.type === 'control.requested' && typeof payload.requestId === 'string')
    return {
      kind: 'decision',
      id: 'decision:control:' + payload.requestId,
      at,
      inboxItemId: 'control:' + payload.requestId,
    };
  if (row.type === 'task.created' && typeof payload.id === 'string')
    return { kind: 'task', id: `task:${payload.id}`, at, taskId: payload.id };
  // The deploy_checkpoint call that wrote this is already a step, "Saved a checkpoint".
  if (row.type === 'checkpoint.created') return;
  if (
    [
      'check.queued',
      'check.running',
      'check.succeeded',
      'check.failed',
      'check.interrupted',
      'check.unknown',
    ].includes(row.type) &&
    typeof payload.id === 'string'
  )
    return {
      kind: 'worklog',
      id: `check:${payload.id}`,
      at,
      summary: typeof payload.command === 'string' ? payload.command : `Check ${row.type.slice(6)}`,
      steps: [
        {
          icon: 'terminal',
          text:
            typeof payload.command === 'string' ? payload.command : `Check ${row.type.slice(6)}`,
        },
      ],
      live: ['check.queued', 'check.running'].includes(row.type),
    };
  if (
    [
      'job.queued',
      'job.running',
      'job.progress',
      'job.succeeded',
      'job.failed',
      'job.cancelled',
      'job.unknown',
    ].includes(row.type)
  ) {
    const jobId = payload.jobId || payload.id;
    if (typeof jobId === 'string') {
      const job = context.job?.(jobId);
      // A pipeline's job belongs to no conversation; its ticks would reach every open page.
      if (!row.taskId && !job?.taskId) return;
      const workerId = payload.workerId || job?.workerId;
      const step = jobStep(job, row.type, payload, {
        computer: typeof workerId === 'string' ? context.computer?.(workerId) : undefined,
        taskId: row.taskId || job?.taskId,
      });
      return {
        kind: 'worklog',
        id: `job:${jobId}`,
        at,
        summary: step.text,
        steps: [step],
        live: step.live === true,
      };
    }
  }
  const item = payload.item;
  if (
    ['item.started', 'item.updated', 'item.completed'].includes(row.type) &&
    typeof item?.id === 'string'
  ) {
    if (['tool_call', 'tool_result', 'mcp_tool_call'].includes(item.type)) {
      const call = context.calls?.get(item.id);
      const merged: ToolItem = {
        ...call,
        ...item,
        name: item.name ?? item.tool ?? call?.name,
        arguments: item.arguments ?? call?.arguments,
        startedAt:
          item.startedAt ?? call?.startedAt ?? (item.type === 'tool_result' ? undefined : at),
      };
      if (item.type !== 'tool_result') context.calls?.set(item.id, merged);
      const done = row.type === 'item.completed';
      let step = merged.name
        ? toolStep(merged, done, at)
        : { icon: 'pulse' as const, text: 'Used a tool', ...(done ? {} : { live: true }) };
      if (!step) return;
      // A run that ended before this step did leaves it stopped, not spinning.
      if (step.live && ENDED_RUN.has(run?.status))
        step = {
          ...step,
          live: false,
          outcome: 'Interrupted',
          tone: 'warn',
          ...(typeof run?.error === 'string' && run.error ? { reason: run.error } : {}),
        };
      const id = `work:${row.runId}:${item.id}`;
      return {
        kind: 'worklog',
        id,
        at,
        summary: step.text,
        steps: [{ ...step, id }],
        live: step.live === true,
      };
    }
    const icon = workIcons.get(item.type);
    if (!icon) return;
    const text =
      [item.command, item.name, item.tool, item.query].find(
        (value) => typeof value === 'string' && value,
      ) || item.type.replaceAll('_', ' ');
    const id = `work:${row.runId}:${item.id}`;
    const done = row.type === 'item.completed';
    // When it started, from its first event, so a running step counts its own time.
    const first = context.calls?.get(item.id);
    const startedAt = typeof first?.startedAt === 'string' ? first.startedAt : at;
    if (!first) context.calls?.set(item.id, { startedAt });
    // A command opens to what it ran, and to its output once it finishes.
    const opens = item.type === 'command_execution';
    return {
      kind: 'worklog',
      id,
      at,
      summary: text,
      steps: [
        {
          icon,
          text,
          id,
          ...(opens ? { opens } : {}),
          ...(done ? {} : { live: true, since: startedAt }),
        },
      ],
      live: !done,
    };
  }
}
