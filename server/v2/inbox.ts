import { stateRefresh } from './state-refresh.ts';
import { fail } from '../errors.ts';
import type { InboxItem } from '../../shared/v2/contracts.ts';
import { db, event, get, id, list, now, save } from '../workspace/store.ts';
import { answerQuestion, taskQuestions } from '../workspace/questions.ts';
import { interactiveOperator, interactiveRead } from '../workspace/interactive.ts';

/** Who did the work: the agent that started the run, else the coding tool it ran with. */
export function agentId(run: any): string {
  return (
    [run?.agentId, run?.adapter].find((value) => typeof value === 'string' && value) || 'agent'
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
/**
 * Design proposals replaced by a newer commit used to be withdrawn without an event, and clients
 * that rebuild Waiting on you from events kept showing them. Announce those once.
 */
function announceWithdrawn(owner: string) {
  if (list('v2-inbox-repair', owner).some((row) => row.id === 'withdrawn-events')) return;
  for (const row of list('v2-inbox-native', owner))
    if (row.item.state === 'withdrawn')
      event(owner, row.item.projectId || '', null, 'v2.inbox', { item: row.item });
  save('v2-inbox-repair', owner, { id: 'withdrawn-events' });
}

export function syncInbox(owner: string, invalidateRefresh = true): InboxItem[] {
  if (invalidateRefresh) stateRefresh.invalidate(owner);
  announceWithdrawn(owner);
  return db
    .transaction(() => {
      const answers = new Map(list('v2-inbox-answer', owner).map((r) => [r.id, r.answer]));
      const previous = new Map(list('v2-inbox', owner).map((r) => [r.id, r]));
      const runs = new Map(list('run', owner).map((r) => [r.id, r]));
      const agents = new Map(list('agent', owner).map((r) => [r.id, r.name]));
      const projects = new Map(list('project', owner).map((r) => [r.id, r.name]));
      const questions = list('question', owner);
      const native = list('v2-inbox-native', owner);
      const questionTasks = new Set(
        [
          ...questions.map((r) => r.taskId),
          ...native.filter((r) => r.item.kind === 'question').map((r) => r.item.taskId),
        ].filter(Boolean),
      );
      const replies = new Map<string, NonNullable<InboxItem['context']>>();
      for (const message of questionTasks.size ? list('message', owner) : []) {
        if (
          !questionTasks.has(message.taskId) ||
          message.role !== 'assistant' ||
          message.isProgress ||
          typeof message.content !== 'string' ||
          !message.content.trim()
        )
          continue;
        const previous = replies.get(message.taskId);
        if (!previous || message.createdAt >= previous.createdAt)
          replies.set(message.taskId, {
            text: message.content,
            messageId: message.id,
            createdAt: message.createdAt,
          });
      }
      const present = (item: InboxItem): InboxItem => ({
        ...item,
        fromName:
          agents.get(item.from) ||
          (item.from === 'scout' ? 'Scout' : item.from === 'warden' ? 'Warden' : 'An agent'),
        ...(item.projectId && projects.has(item.projectId)
          ? { projectName: projects.get(item.projectId) }
          : {}),
        context:
          item.kind === 'question' && item.taskId ? (replies.get(item.taskId) ?? null) : null,
      });
      const taskIds = new Set([
        ...questions.map((r) => r.taskId),
        ...list('interactive-request', owner).map((r) => r.taskId),
      ]);
      const items: InboxItem[] = [];
      for (const taskId of taskIds) {
        const task = get('task', owner, taskId);
        const sources: ['question' | 'control', any[]][] = [
          ['question', taskQuestions(owner, taskId)],
          ['control', interactiveRead(owner, taskId).requests],
        ];
        for (const [kind, rows] of sources) {
          for (const row of rows) {
            const item = present(
              mapInboxItem(kind, row, task, runs.get(row.runId), answers.get(kind + ':' + row.id)),
            );
            if (JSON.stringify(previous.get(item.id)) !== JSON.stringify(item)) {
              save('v2-inbox', owner, item);
              event(owner, taskId, row.runId, 'v2.inbox', { item });
            }
            items.push(item);
          }
        }
      }
      items.push(...native.map((row) => present(row.item)));
      return items.sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
      );
    })
    .immediate();
}

/** The item an answer is for, or why that answer cannot be given. */
function answerable(owner: string, itemId: string, body: any): InboxItem {
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
  if (body.surface !== undefined && (body.surface !== 'menu-bar' || body.on !== 'desktop'))
    fail('Menu bar answers require the desktop source');
  if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 4000))
    fail('Note must contain at most 4000 characters');
  if (!item.actions.some((action) => action.id === body.actionId)) fail('Unknown answer action');
  return item;
}

export function answerInbox(owner: string, itemId: string, body: any, prepared?: unknown) {
  return db
    .transaction((): InboxItem => {
      const item = answerable(owner, itemId, body);
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
      const answer: InboxItem['answer'] = {
        actionId: body.actionId,
        by: owner,
        on: body.on,
        ...(body.surface ? { surface: body.surface } : {}),
        at: now(),
        ...(note ? { note } : {}),
      };
      if (item.kind !== 'question' && item.kind !== 'control') {
        const row = get('v2-inbox-native', owner, itemId);
        // A producer that shares a kind names itself in its context and gets its own handler.
        const handler =
          sourceActions.get(row.context?.source)?.handler ?? nativeActions.get(item.kind);
        if (!['not-now', 'keep', 'dismiss'].includes(body.actionId)) {
          if (!handler)
            fail('This action is not available yet. The decision is still waiting.', 501);
          handler(owner, item, body, row.context, prepared);
        }
        const answered = { ...item, state: 'answered' as const, answer };
        save('v2-inbox-native', owner, { ...row, item: answered });
        event(owner, item.projectId || '', null, 'v2.inbox', { item: answered });
      }
      save('v2-inbox-answer', owner, { id: itemId, answer });
      return syncInbox(owner).find((entry) => entry.id === itemId)!;
    })
    .immediate();
}

/**
 * Answer an item, first doing any awaited work its source declared. A SQLite transaction cannot
 * wait, so that work happens outside it and hands its result to the source's handler.
 */
export async function answerInboxAsync(owner: string, itemId: string, body: any) {
  const context = list('v2-inbox-native', owner).find((row) => row.id === itemId)?.context;
  const prepare = sourceActions.get(context?.source)?.prepare;
  if (!prepare) return answerInbox(owner, itemId, body);
  return prepare({
    owner,
    body,
    context,
    check: () => answerable(owner, itemId, body),
    answer: (prepared) => answerInbox(owner, itemId, body, prepared),
  });
}

// Producers keep their execution context private; clients receive only the typed decision.
// Handlers synchronously persist work in the answer transaction; never perform async lookups.
// A source that must await something first does it in its `prepare`.
type InboxHandler = (
  owner: string,
  item: InboxItem,
  body: any,
  context: any,
  prepared?: any,
) => void;
type InboxPreparation = (input: {
  owner: string;
  body: any;
  context: any;
  /** The answer's own checks; repeat them once anything could have changed. */
  check: () => InboxItem;
  /** The answer's transaction, which passes `prepared` to the handler. */
  answer: (prepared: unknown) => InboxItem;
}) => Promise<InboxItem>;
const nativeActions = new Map<InboxItem['kind'], InboxHandler>();
export function registerInboxAction(kind: InboxItem['kind'], handler: InboxHandler) {
  nativeActions.set(kind, handler);
  return () => {
    if (nativeActions.get(kind) === handler) nativeActions.delete(kind);
  };
}
const sourceActions = new Map<string, { handler: InboxHandler; prepare?: InboxPreparation }>();
/** Handle the decisions whose private context says `source`, whatever their public kind. */
export function registerInboxSource(
  source: string,
  handler: InboxHandler,
  prepare?: InboxPreparation,
) {
  sourceActions.set(source, { handler, prepare });
  return () => {
    if (sourceActions.get(source)?.handler === handler) sourceActions.delete(source);
  };
}
export function createInboxItem(owner: string, item: InboxItem, context: unknown): InboxItem {
  return db
    .transaction(() => {
      const previous = list('v2-inbox-native', owner).find((row) => row.id === item.id);
      if (previous) return previous.item;
      save('v2-inbox-native', owner, { id: item.id, item, context });
      event(owner, item.projectId || '', null, 'v2.inbox', { item });
      return item;
    })
    .immediate();
}

export function withdrawInboxItems(owner: string, projectId: string, kind: InboxItem['kind']) {
  for (const row of list('v2-inbox-native', owner)) {
    if (row.item.projectId !== projectId || row.item.kind !== kind || row.item.state !== 'waiting')
      continue;
    const item = { ...row.item, state: 'withdrawn' };
    save('v2-inbox-native', owner, { ...row, item });
    event(owner, projectId, null, 'v2.inbox', { item });
  }
}
