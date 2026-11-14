/** Resume recorded answers after the original run has ended. */
export type QuestionAnswerResumer = (owner: string, taskId: string, runId: string) => void;
