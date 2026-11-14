// questions used to enter service before completing its own evaluation.
import { wireTaskRunStarter } from './task-run-starter.ts';
import { wireQuestionAnswerResumer } from './question-answer-resumer.ts';
export { resumeQuestionAnswers } from '../workspace/questions.ts';

export function wireLocalWorkerTaskRuns() {
  wireTaskRunStarter();
  wireQuestionAnswerResumer();
}
