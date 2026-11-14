/** Product operation needed by the workspace. No feature dependencies. */
export type MergePermissionSource = () => Promise<
  (owner: string, agent: string, action: 'merge', projectId?: string) => boolean
>;
