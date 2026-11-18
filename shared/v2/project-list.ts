import type { ProjectListGroup } from './contracts.ts';

export const PROJECT_LIST_GROUPS: ProjectListGroup[] = ['live', 'repositories', 'archived'];
export const PROJECT_LIST_DEFAULT: ProjectListGroup[] = ['live', 'repositories'];
/** Repositories on the first page of the Projects list. */
export const REPOSITORY_PAGE = 6;

/** The Projects page's read. The server seeds the default, so both sides build the same path. */
export function projectListPath(
  show: ProjectListGroup[] = PROJECT_LIST_DEFAULT,
  query = '',
  limit = REPOSITORY_PAGE,
) {
  const groups = PROJECT_LIST_GROUPS.filter((group) => show.includes(group));
  const search = query.trim();
  return `/api/projects?view=list&show=${groups.join(',')}&limit=${limit}${search ? `&q=${encodeURIComponent(search)}` : ''}`;
}

export function projectListOptions(params: URLSearchParams) {
  const asked = (params.get('show') ?? PROJECT_LIST_DEFAULT.join(',')).split(',');
  return {
    show: PROJECT_LIST_GROUPS.filter((group) => asked.includes(group)),
    query: params.get('q') ?? '',
    limit: Number(params.get('limit')) || REPOSITORY_PAGE,
  };
}
