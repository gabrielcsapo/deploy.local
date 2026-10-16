import { createHash } from 'node:crypto';
import { command, db, event, get, id, list, now, save } from './store.ts';
import type { AgentScope } from './coordination.ts';

function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}
function active(owner: string, taskId: string, runId: string) {
  const run = get('run', owner, runId);
  return (
    run.taskId === taskId && ['starting', 'running'].includes(run.status) && !run.stopRequested
  );
}
function current(owner: string, question: any) {
  if (question.status !== 'pending') return question;
  const status = !active(owner, question.taskId, question.runId)
    ? 'cancelled'
    : Date.now() >= question.expiresAt
      ? 'expired'
      : 'pending';
  if (status === 'pending') return question;
  const result = save('question', owner, { ...question, status, updatedAt: now() });
  event(owner, question.taskId, question.runId, 'question.' + status, { id: question.id });
  return result;
}
export function taskQuestions(owner: string, taskId: string) {
  get('task', owner, taskId);
  return db.transaction(() =>
    list('question', owner)
      .filter((q) => q.taskId === taskId)
      .map((q) => current(owner, q)),
  )();
}
export function questionTool(scope: AgentScope, args: any) {
  const { owner, taskId, runId } = scope;
  if (args.action === 'read') {
    const q = get('question', owner, args.questionId);
    if (q.taskId !== taskId || q.runId !== runId) fail('Question belongs to another run', 403);
    return db.transaction(() => current(owner, q))();
  }
  if (args.action && args.action !== 'request') fail('Unknown question action');
  if (!active(owner, taskId, runId)) fail('Run is no longer active', 409);
  const question = typeof args.question === 'string' ? args.question.trim() : '';
  const options = args.options ?? [];
  if (!question || question.length > 2000) fail('Question must contain 1–2000 characters');
  if (
    !Array.isArray(options) ||
    options.length > 5 ||
    options.some((o) => typeof o !== 'string' || !o.trim() || o.length > 200) ||
    new Set(options).size !== options.length
  )
    fail('Provide up to five distinct short options');
  const signature = createHash('sha256')
    .update(JSON.stringify({ taskId, runId, question, options }))
    .digest('hex');
  return command(
    owner,
    args.operationId,
    () => {
      if (taskQuestions(owner, taskId).some((q) => q.runId === runId && q.status === 'pending'))
        fail('This run already has a pending question', 409);
      const q = save('question', owner, {
        id: id(),
        taskId,
        runId,
        question,
        options,
        status: 'pending',
        answer: null,
        createdAt: now(),
        expiresAt: Date.now() + 30 * 60_000,
      });
      event(owner, taskId, runId, 'question.requested', q);
      return q;
    },
    signature,
  );
}
export function answerQuestion(owner: string, taskId: string, questionId: string, body: any) {
  return db.transaction(() => {
    const q = get('question', owner, questionId);
    if (q.taskId !== taskId) fail('Question belongs to another task', 403);
    const status = body.dismiss === true ? 'dismissed' : 'answered';
    const answer =
      status === 'dismissed' ? null : typeof body.answer === 'string' ? body.answer.trim() : '';
    if (status === 'answered' && (!answer || answer.length > 4000))
      fail('Answer must contain 1–4000 characters');
    const existing = current(owner, q);
    if (existing.status !== 'pending') {
      if (existing.status === status && existing.answer === answer) return existing;
      fail('This question is already resolved or no longer active', 409);
    }
    const result = save('question', owner, { ...q, status, answer, updatedAt: now() });
    event(owner, taskId, q.runId, 'question.' + status, result);
    return result;
  })();
}
