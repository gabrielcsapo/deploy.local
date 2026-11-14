/** Product operation needed by the workspace. No feature dependencies. */
export type WorkspaceDesignTool = (
  scope: { owner: string; taskId: string; runId?: string },
  args: any,
) => Promise<any>;
