/** Synchronous run creation inside the caller's existing decision transaction. */
export type TaskRunStarter = (
  owner: string,
  taskId: string,
  input: any,
  answeredQuestionId?: string,
  checkpointContinuation?: boolean,
) => any;
