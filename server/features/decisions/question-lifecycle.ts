import { event, list, now, save } from '../../workspace/store.ts';

export function cancelTaskQuestions(owner: string, taskId: string, exceptId?: string) {
  for (const q of list('question', owner).filter(
    (row) =>
      row.taskId === taskId &&
      row.id !== exceptId &&
      (row.status === 'pending' ||
        (row.status === 'answered' && !row.deliveredAt && !row.followUpRunId)),
  )) {
    save('question', owner, { ...q, status: 'cancelled', updatedAt: now() });
    event(owner, taskId, q.runId, 'question.cancelled', { id: q.id });
  }
}
