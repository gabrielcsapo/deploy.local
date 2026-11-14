import type { QuestionAnswerResumer } from '../contracts/question-answer-resumer.ts';

let provider: QuestionAnswerResumer | undefined;

export function registerQuestionAnswerResumer(value: QuestionAnswerResumer) {
  provider = value;
}

export function requireQuestionAnswerResumer(processName: string): QuestionAnswerResumer {
  if (!provider) throw new Error(`QuestionAnswerResumer is not wired in ${processName}`);
  return provider;
}
