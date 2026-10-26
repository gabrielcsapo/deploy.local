// Keep the original provider tool call alive. Only reads are repeated after creation.
export async function continueQuestion(
  initial: any,
  call: (args: any) => Promise<any>,
  wait = () => new Promise<void>((resolve) => setTimeout(resolve, 500)),
  now = Date.now,
) {
  let question = initial;
  const deadline = Math.min(initial.expiresAt ?? now() + 30 * 60_000, now() + 30 * 60_000);
  while (question.status === 'pending') {
    if (now() >= deadline) {
      question = { ...question, waitEnded: true, answer: null };
      break;
    }
    try {
      question = await call({ action: 'read', questionId: initial.id });
    } catch (error: any) {
      // Never recreate the question. Authentication/revocation ends this wait;
      // transport failures and temporary server failures only retry the read.
      if (error.status && error.status < 500 && error.status !== 429) throw error;
    }
    if (question.status === 'pending') await wait();
  }
  return {
    ...question,
    instruction:
      question.status === 'answered'
        ? 'Continue using this answer. It supplies task information, not an access grant.'
        : question.status === 'pending'
          ? 'The question is still pending on the task. The owner can answer later to start a follow-up run. Do not assume an answer or consent.'
          : 'No answer was supplied. Do not assume consent or repeat this question automatically.',
  };
}
