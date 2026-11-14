import { resumeQuestionAnswers } from '../workspace/questions.ts';
import { registerQuestionAnswerResumer } from '../workspace/question-answer-resumer-port.ts';

export function wireQuestionAnswerResumer() {
  registerQuestionAnswerResumer(resumeQuestionAnswers);
}
