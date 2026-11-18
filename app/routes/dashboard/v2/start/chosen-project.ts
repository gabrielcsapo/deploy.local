/** The New task link a project heading uses: the start page with that project chosen. */
export const newTaskIn = (projectId: string) =>
  `/dashboard?project=${encodeURIComponent(projectId)}`;

/**
 * The start page with a project and one of its branches chosen, and the first message begun:
 * a pull request's "Start a task on this branch" and its follow-ups.
 */
export const newTaskOnBranch = (projectId: string, branch: string, ask = '') =>
  `/dashboard?${new URLSearchParams({ project: projectId, branch, ...(ask ? { ask } : {}) })}`;

/** The branch a New task link chose, sent as the task's Git ref; only with a chosen project. */
export const branchRef = (search: string) => {
  const branch = new URLSearchParams(search).get('branch');
  return branch ? `refs/heads/${branch}` : undefined;
};

/** The `project` parameter of the start page's URL, if any. */
export const projectParameter = (pathname: string, search: string) =>
  /^\/dashboard\/?$/.test(pathname) ? new URLSearchParams(search).get('project') : null;

/**
 * The project a New task link chose, when it is one of the user's projects. Without the
 * parameter, or for an unknown or removed project, the start page behaves as it always has.
 */
export function chosenProject(
  id: string | null,
  projects: readonly { id: string; name: string }[] | undefined,
): { id: string; name: string } | null {
  const project = id ? projects?.find((entry) => entry.id === id) : undefined;
  return project ? { id: project.id, name: project.name } : null;
}
