import './attachments.ts';
import type { V2Event, V2EventsResponse } from '../../shared/v2/api.ts';
import { list } from '../workspace/store.ts';
import { cursor as eventCursor, events, createOwnerEventPoller } from '../kernel/events/index.ts';
import './inbox.ts';
import { stateRefresh } from './state-refresh.ts';
import { mapConversationEvent } from '../features/agents/conversation-events.ts';
export { mapConversationEvent } from '../features/agents/conversation-events.ts';

const poller = createOwnerEventPoller({ head: eventCursor, refresh: stateRefresh.read });

/** Poll SQLite, including time-based inbox expiry, so independent workers can wake clients. */
export async function waitForV2Events(
  owner: string,
  after: number,
  waitMs: number,
  signal: AbortSignal,
): Promise<V2EventsResponse> {
  const deadline = Date.now() + Math.min(10_000, Math.max(0, waitMs));
  let cursor = after;
  let firstPass = true;
  let runs: Map<string, any> | undefined;
  for (;;) {
    signal.throwIfAborted();
    if (firstPass) {
      firstPass = false;
      await stateRefresh.read(owner);
    }
    signal.throwIfAborted();
    const rows = events(owner, cursor);
    const result: V2Event[] = [];
    for (const row of rows) {
      const base = {
        cursor: row.cursor,
        taskId: row.taskId,
        runId: row.runId,
        at: row.createdAt,
      };
      if (row.type === 'agent.changed')
        result.push({ ...base, type: 'agent', agentId: row.payload.agentId });
      else if (row.type === 'v2.inbox')
        result.push({ ...base, type: 'inbox', item: row.payload.item });
      else if (row.type === 'v2.health')
        result.push({ ...base, type: 'health', app: row.payload.app });
      else if (row.type === 'v2.release')
        result.push({ ...base, type: 'release', release: row.payload.release });
      else if (row.type === 'v2.rollback')
        result.push({ ...base, type: 'rollback', rollback: row.payload.rollback });
      else if (row.type === 'task.deleted') result.push({ ...base, type: 'task-deleted' });
      else {
        runs ??= new Map(list('run', owner).map((run) => [run.id, run]));
        const event = mapConversationEvent(row, runs.get(row.runId));
        if (event) result.push({ ...base, type: 'conversation', event });
      }
      cursor = row.cursor;
    }
    if (result.length || (rows.length < 1000 && Date.now() >= deadline))
      return { events: result, cursor, supportsWait: true };
    // Drain full pages before sleeping; ignored events must not strand mapped events behind them.
    if (rows.length === 1000) continue;
    await poller.wait(owner, cursor, deadline, signal);
    runs = undefined;
  }
}
