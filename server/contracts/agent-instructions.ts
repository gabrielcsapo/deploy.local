/** Product operation needed by the workspace. No feature dependencies. */
export type AgentInstructionsSource = (
  owner: string,
  task: { agentId?: string; createdAt: string },
) => string;
