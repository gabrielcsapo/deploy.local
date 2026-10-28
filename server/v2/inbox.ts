import type { InboxItem } from '../../shared/v2/contracts.ts';
import { db, event, get, id, list, now, save } from '../workspace/store.ts';
import { answerQuestion, taskQuestions } from '../workspace/questions.ts';
import { interactiveOperator, interactiveRead } from '../workspace/interactive.ts';

export function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

export function agentId(run: any): string {
  return (
    [run?.agentId, run?.adapter].find((value) => typeof value === 'string' && value) || 'scout'
  );
}

export function mapInboxItem(
  kind: 'question' | 'control',
  row: any,
  task: any,
  run: any,
  answer?: InboxItem['answer'],
): InboxItem {
  const state = ['answered', 'dismissed', 'approved', 'denied'].includes(row.status)
    ? 'answered'
    : row.status === 'pending'
      ? 'waiting'
      : row.status === 'expired'
        ? 'expired'
        : 'withdrawn';
  return {
    id: kind + ':' + row.id,
    kind,
    title: kind === 'question' ? row.question : 'Use the screen?',
    text: kind === 'question' ? row.question : `Use ${row.targetLabel} for this task.`,
    from: agentId(run),
    ...(task.projectId ? { projectId: task.projectId } : {}),
    taskId: row.taskId,
    createdAt: row.createdAt,
    actions:
      kind === 'question'
        ? [
            ...(row.options || []).map((label: string, index: number) => ({
              id: 'option:' + index,
              label,
              ...(index === 0 ? { primary: true } : {}),
            })),
            { id: 'answer', label: 'Answer' },
            { id: 'dismiss', label: 'Dismiss' },
          ]
        : [
            { id: 'approve', label: 'Allow', primary: true },
            { id: 'deny', label: 'Deny' },
          ],
    state,
    ...(answer ? { answer } : {}),
  };
}

/** Persist projections so readers in different processes see the same inbox changes. */
export function syncInbox(owner: string): InboxItem[] {
  return db
    .transaction(() => {
      const answers = new Map(list('v2-inbox-answer', owner).map((r) => [r.id, r.answer]));
      const previous = new Map(list('v2-inbox', owner).map((r) => [r.id, r]));
      const runs = new Map(list('run', owner).map((r) => [r.id, r]));
      const taskIds = new Set([
        ...list('question', owner).map((r) => r.taskId),
        ...list('interactive-request', owner).map((r) => r.taskId),
      ]);
      const items: InboxItem[] = list('v2-inbox-produced', owner).map((item) => ({
        ...item,
        ...(answers.has(item.id) ? { state: 'answered', answer: answers.get(item.id) } : {}),
      }));
      for (const taskId of taskIds) {
        const task = get('task', owner, taskId);
        const sources: ['question' | 'control', any[]][] = [
          ['question', taskQuestions(owner, taskId)],
          ['control', interactiveRead(owner, taskId).requests],
        ];
        for (const [kind, rows] of sources) {
          for (const row of rows) {
            const item = mapInboxItem(
              kind,
              row,
              task,
              runs.get(row.runId),
              answers.get(kind + ':' + row.id),
            );
            if (JSON.stringify(previous.get(item.id)) !== JSON.stringify(item)) {
              save('v2-inbox', owner, item);
              event(owner, taskId, row.runId, 'v2.inbox', { item });
            }
            items.push(item);
          }
        }
      }
      return items.sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
      );
    })
    .immediate();
}

export function answerInbox(owner: string, itemId: string, body: any): InboxItem {
  return db
    .transaction(() => {
      const item = syncInbox(owner).find((entry) => entry.id === itemId);
      if (!item) fail('Not found', 404);
      if (item.state !== 'waiting')
        throw Object.assign(new Error('This item is already resolved or no longer active'), {
          status: 409,
          answer: item.answer ?? null,
          item,
        });
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Answer object required');
      if (!['web', 'iphone', 'desktop', 'cli'].includes(body.on)) fail('Answer source required');
      if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 4000))
        fail('Note must contain at most 4000 characters');
      if (!item.actions.some((action) => action.id === body.actionId))
        fail('Unknown answer action');
      const sourceId = item.id.slice(item.id.indexOf(':') + 1);
      const note = body.note?.trim();
      if (item.kind === 'question') {
        const question = get('question', owner, sourceId);
        answerQuestion(owner, item.taskId!, sourceId, {
          dismiss: body.actionId === 'dismiss',
          answer:
            body.actionId === 'answer' ? note : question.options[Number(body.actionId.slice(7))],
        });
      } else if (item.kind === 'control') {
        interactiveOperator(owner, item.taskId!, body.actionId, {
          requestId: sourceId,
          clientId: id(),
          operationId: id(),
        });
      }
      if (item.kind !== 'question' && item.kind !== 'control' && body.actionId !== 'dismiss') {
        const handler = inboxActions.get(item.kind + ':' + body.actionId);
        if (!handler) fail('This action is not available yet. The decision is still waiting.', 501);
        handler(owner, item);
      }
      const answer: InboxItem['answer'] = {
        actionId: body.actionId,
        by: owner,
        on: body.on,
        at: now(),
        ...(note ? { note } : {}),
      };
      save('v2-inbox-answer', owner, { id: itemId, answer });
      if (item.kind !== 'question' && item.kind !== 'control') {
        const answered = { ...item, state: 'answered' as const, answer };
        save('v2-inbox', owner, answered);
        event(owner, item.taskId ?? '', null, 'v2.inbox', { item: answered });
      }
      return syncInbox(owner).find((entry) => entry.id === itemId)!;
    })
    .immediate();
}

// Producers use stable IDs so polling and repeated reports never duplicate a decision.
export function publishInboxItem(owner: string, item: InboxItem): InboxItem {
  return db
    .transaction(() => {
      const existing = list('v2-inbox-produced', owner).find((entry) => entry.id === item.id);
      if (existing) return existing;
      save('v2-inbox-produced', owner, item);
      save('v2-inbox', owner, item);
      event(owner, item.taskId ?? '', null, 'v2.inbox', { item });
      return item;
    })
    .immediate();
}

const inboxActions = new Map<string, (owner: string, item: InboxItem) => void>();
/** Register a synchronous durable enqueue, never an unawaited network mutation. */
export function registerInboxAction(
  kind: InboxItem['kind'],
  action: string,
  handler: (owner: string, item: InboxItem) => void,
) {
  inboxActions.set(kind + ':' + action, handler);
  return () => inboxActions.delete(kind + ':' + action);
}
