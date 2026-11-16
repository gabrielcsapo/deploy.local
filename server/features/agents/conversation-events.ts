import { mapMediaEvent } from './media-event.ts';
import type { ConversationEvent, WorkStep } from '../../../shared/v2/contracts.ts';
import { agentId } from '../decisions/inbox.ts';

const workIcons = new Map<string, WorkStep['icon']>([
  ['command_execution', 'terminal'],
  ['file_change', 'edit'],
  ['web_search', 'search'],
  ['tool_call', 'pulse'],
  ['tool_result', 'pulse'],
  ['mcp_tool_call', 'pulse'],
]);

export function mapConversationEvent(row: any, run?: any): ConversationEvent | undefined {
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
  if (row.type === 'checkpoint.created' && typeof payload.checkpointId === 'string')
    return {
      kind: 'worklog',
      id: `checkpoint:${payload.checkpointId}`,
      at,
      summary: 'Checkpoint saved',
      live: false,
      steps: [{ icon: 'file', text: payload.digest || payload.checkpointId }],
    };
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
    if (typeof jobId === 'string')
      return {
        kind: 'worklog',
        id: `job:${jobId}`,
        at,
        summary: `Work ${row.type.slice(4)}`,
        steps: [
          {
            icon: 'terminal',
            text:
              typeof payload.command === 'string' ? payload.command : `Work ${row.type.slice(4)}`,
          },
        ],
        live: ['job.queued', 'job.running', 'job.progress'].includes(row.type),
      };
  }
  const item = payload.item;
  if (
    ['item.started', 'item.updated', 'item.completed'].includes(row.type) &&
    typeof item?.id === 'string'
  ) {
    const icon = workIcons.get(item.type);
    if (!icon) return;
    const text =
      [item.command, item.name, item.tool, item.query].find(
        (value) => typeof value === 'string' && value,
      ) || item.type.replaceAll('_', ' ');
    return {
      kind: 'worklog',
      id: `work:${row.runId}:${item.id}`,
      at,
      summary: text,
      steps: [{ icon, text }],
      live: row.type !== 'item.completed',
    };
  }
}
