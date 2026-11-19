/**
 * Where the Design page reads its design: deploy.local's API (null), or a folder on this
 * computer through `deploy design dev`, which serves this same page with its settings. The data
 * comes through the same design API either way; what only deploy.local has (comments, review,
 * agents, presence, the inbox) is left off the page when it is the folder.
 */
export type DesignLocal = {
  /** The project's name. */
  project: string;
  /** The branch checked out in the folder. */
  branch: string;
  /** deploy.local, where comments, review and agents are. */
  deployUrl: string;
  /** "Mac", or "computer" elsewhere. */
  machine: string;
};

export function designLocal(): DesignLocal | null {
  if (typeof window === 'undefined') return null;
  return (window as { __DEPLOY_DESIGN_LOCAL__?: DesignLocal }).__DEPLOY_DESIGN_LOCAL__ ?? null;
}

/** The one project a folder's page shows, as its addresses name it. */
export const localProjectId = 'local';
