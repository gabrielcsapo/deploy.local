/** Product operation needed by the workspace. No feature dependencies. */
export type RepositoryProjectCreator = (
  owner: string,
  input: any,
  signature?: string,
) => Promise<{
  id: string;
  name: string;
  apps: { id: string; name: string; kind: 'web' | 'worker' }[];
}>;
