import { mapMediaEvent } from './attachments.ts';
import { setTimeout as delay } from 'node:timers/promises';
import type { ConversationEvent, WorkStep } from '../../shared/v2/contracts.ts';
import type { V2Event, V2EventsResponse } from '../../shared/v2/api.ts';
import { events, list } from '../workspace/store.ts';
import { getLive } from './live.ts';
import { agentId, syncInbox } from './inbox.ts';

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

/** Poll SQLite, including time-based inbox expiry, so independent workers can wake clients. */
export async function waitForV2Events(
  owner: string,
  after: number,
  waitMs: number,
  signal: AbortSignal,
): Promise<V2EventsResponse> {
  const deadline = Date.now() + Math.min(10_000, Math.max(0, waitMs));
  let cursor = after;
  for (;;) {
    signal.throwIfAborted();
    await getLive(owner);
    syncInbox(owner);
    const rows = events(owner, cursor);
    const runs = new Map(list('run', owner).map((run) => [run.id, run]));
    const result: V2Event[] = [];
    for (const row of rows) {
      const base = { cursor: row.cursor, taskId: row.taskId, runId: row.runId, at: row.createdAt };
      if (row.type === 'v2.inbox') result.push({ ...base, type: 'inbox', item: row.payload.item });
      else if (row.type === 'v2.health')
        result.push({ ...base, type: 'health', app: row.payload.app });
      else if (row.type === 'v2.release')
        result.push({ ...base, type: 'release', release: row.payload.release });
      else if (row.type === 'v2.rollback')
        result.push({ ...base, type: 'rollback', rollback: row.payload.rollback });
      else {
        const event = mapConversationEvent(row, runs.get(row.runId));
        if (event) result.push({ ...base, type: 'conversation', event });
      }
      cursor = row.cursor;
    }
    if (result.length || (rows.length < 1000 && Date.now() >= deadline))
      return { events: result, cursor, supportsWait: true };
    // Drain full pages before sleeping; ignored events must not strand mapped events behind them.
    if (rows.length === 1000) continue;
    await delay(Math.min(50, deadline - Date.now()), undefined, { signal });
  }
}
