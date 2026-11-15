import { fail } from '../../kernel/errors.ts';
import { createHash } from 'node:crypto';
import { command, db, event, get, id, list, now, save } from '../../workspace/store.ts';
import { requireTaskRunStarter } from '../../workspace/task-run-starter-port.ts';
import { cancelTaskQuestions } from './question-lifecycle.ts';
import type { AgentScope } from '../../workspace/coordination.ts';

function active(owner: string, taskId: string, runId: string) {
  const run = get('run', owner, runId);
  return (
    run.taskId === taskId && ['starting', 'running'].includes(run.status) && !run.stopRequested
  );
}
function current(owner: string, question: any) {
  if (question.status !== 'pending') return question;
  if (['done', 'merged'].includes(get('task', owner, question.taskId).status)) {
    cancelTaskQuestions(owner, question.taskId);
    return get('question', owner, question.id);
  }
  return question;
}
/** Inventory attention signals without an HTTP detail read for every running task. */
export function tasksWaitingForAnswer(owner: string): Set<string> {
  return db.transaction(
    () =>
      new Set<string>(
        list('question', owner)
          .filter((q) => q.status === 'pending')
          .map((q) => current(owner, q))
          .filter((q) => q.status === 'pending')
          .map((q) => q.taskId),
      ),
  )();
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
    return db.transaction(() => {
      const result = current(owner, q);
      return result.status === 'answered' && !result.deliveredAt
        ? save('question', owner, { ...result, deliveredAt: now() })
        : result;
    })();
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
        expiresAt: null,
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
      if (existing.status === status && existing.answer === answer)
        return status === 'answered' ? resumeQuestion(owner, existing) : existing;
      fail('This question is already resolved or no longer active', 409);
    }
    let result = save('question', owner, { ...q, status, answer, updatedAt: now() });
    if (status === 'answered') result = resumeQuestion(owner, result);
    event(owner, taskId, q.runId, 'question.' + status, result);
    return result;
  })();
}

/** The original tool consumes live answers; unread answers resume after the run ends. */
function resumeQuestion(owner: string, q: any) {
  if (q.status !== 'answered' || q.deliveredAt || q.followUpRunId) return q;
  if (
    list('run', owner).some(
      (r) =>
        r.taskId === q.taskId && ['queued', 'starting', 'running', 'unknown'].includes(r.status),
    )
  )
    return q;
  const task = get('task', owner, q.taskId);
  if (['done', 'merged'].includes(task.status)) return q;
  const prior = get('run', owner, q.runId);
  const run = requireTaskRunStarter('workspace')(
    owner,
    q.taskId,
    {
      revision: task.revision,
      adapter: prior.adapter,
      model: prior.model,
      effort: prior.effort,
      content: `Agent question: ${q.question}\nOwner answer: ${q.answer}`,
    },
    q.id,
  );
  return save('question', owner, { ...q, followUpRunId: run.id });
}

export function resumeQuestionAnswers(owner: string, taskId: string, runId: string) {
  return db.transaction(() => {
    for (const q of list('question', owner).filter(
      (q) => q.taskId === taskId && q.runId === runId,
    )) {
      // A changed provider configuration should leave the recorded answer retryable.
      try {
        resumeQuestion(owner, q);
      } catch (error: any) {
        event(owner, taskId, runId, 'question.resume_failed', { id: q.id, error: error.message });
      }
    }
  })();
}
