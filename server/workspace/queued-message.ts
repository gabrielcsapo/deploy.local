import { validateAttachments } from './attachments.ts';
import { get, list, save, remove, event, now } from './store.ts';
import { startRun } from './service.ts';

// One follow-up per task may wait for the active turn. It lives on the coordinator so any
// client (web, iPhone, Mac) sees and can cancel the same message.
const activeRun = (owner: string, taskId: string) =>
  list('run', owner).some(
    (r) => r.taskId === taskId && ['queued', 'starting', 'running', 'unknown'].includes(r.status),
  );
export function queuedMessage(owner: string, taskId: string) {
  try {
    return get('queued-message', owner, taskId);
  } catch {
    return null;
  }
}
const settings = (input: any) => ({
  attachmentIds: input.attachmentIds || [],
  adapter: input.adapter || 'codex',
  model: typeof input.model === 'string' ? input.model : undefined,
  effort: typeof input.effort === 'string' ? input.effort : undefined,
});
export function queueMessage(owner: string, taskId: string, input: any) {
  const task = get('task', owner, taskId);
  const content = String(input.content || '').trim();
  const attachments = validateAttachments(owner, taskId, input.attachmentIds);
  if ((!content && !attachments.length) || content.length > 100000)
    throw new Error('Message required (maximum 100000 characters)');
  // The turn may have ended while the client was deciding; send now instead of waiting forever.
  if (!activeRun(owner, taskId))
    return { sent: true, run: startRun(owner, taskId, { ...input, revision: task.revision }) };
  const existing = queuedMessage(owner, taskId);
  if (existing?.status === 'queued')
    throw Object.assign(new Error('A message is already queued for this turn'), { status: 409 });
  const queued = save('queued-message', owner, {
    id: taskId,
    taskId,
    content,
    ...settings(input),
    status: 'queued',
    reason: null,
    createdAt: now(),
  });
  event(owner, taskId, null, 'message.queued', { status: 'queued' });
  return { sent: false, queued };
}
export function cancelQueuedMessage(owner: string, taskId: string) {
  get('task', owner, taskId);
  if (!queuedMessage(owner, taskId)) return { cancelled: false };
  remove('queued-message', owner, taskId);
  event(owner, taskId, null, 'message.queue_cancelled', {});
  return { cancelled: true };
}
const heldReason: Record<string, string> = {
  failed: 'Not sent because the turn failed.',
  interrupted: 'Not sent because the turn was stopped.',
  unknown: 'Not sent because the turn ended in an unknown state.',
};
/** Called after a run reaches a terminal status. Only a successful turn sends the follow-up. */
export function releaseQueuedMessage(owner: string, taskId: string, status: string) {
  const queued = queuedMessage(owner, taskId);
  if (queued?.status !== 'queued') return null;
  const hold = (reason: string) => {
    save('queued-message', owner, { ...queued, status: 'held', reason, updatedAt: now() });
    event(owner, taskId, null, 'message.queue_held', { reason });
    return null;
  };
  if (status !== 'succeeded') return hold(heldReason[status] || heldReason.unknown);
  try {
    const run = startRun(owner, taskId, {
      ...settings(queued),
      content: queued.content,
      revision: get('task', owner, taskId).revision,
    });
    event(owner, taskId, run.id, 'message.queue_sent', {});
    return run;
  } catch (error: any) {
    return hold(`Not sent: ${error.message}`);
  }
}
