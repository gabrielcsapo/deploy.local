import type {
  Project,
  ProjectListGroup,
  ProjectListResponse,
} from '../../../shared/v2/contracts.ts';
import { list } from '../../workspace/store.ts';
import { projectsForOwner } from './projects.ts';
import { commitText, repositoryRefs } from './repository-views.ts';

const GROUPS: ProjectListGroup[] = ['live', 'repositories', 'archived'];
/** The most repositories one request returns. */
const REPOSITORY_LIMIT = 200;

export function projectListGroup(project: Project): ProjectListGroup {
  return project.stage === 'done' ? 'archived' : project.apps.length ? 'live' : 'repositories';
}

/**
 * The Projects page in one read. Only what the page draws is opened: every repository's refs,
 * which are already kept for the sidebar, decide the order; a commit is read only for the
 * repositories on the page asked for. The transport adds request counts to live projects.
 * A search looks through every group, so an archived project turns up by name.
 */
export async function projectList(
  owner: string,
  options: { show?: ProjectListGroup[]; query?: string; limit?: number } = {},
): Promise<ProjectListResponse> {
  const query = (options.query || '').trim().toLowerCase();
  const show = new Set(query ? GROUPS : (options.show ?? ['live', 'repositories']));
  const limit = Math.max(1, Math.min(REPOSITORY_LIMIT, Math.floor(options.limit || 6)));
  const projects = await projectsForOwner(owner, true);
  const repositories = list('project', owner);
  const pulls = list('pull-request', owner);
  const counts = { live: 0, repositories: 0, archived: 0 };
  for (const project of projects) counts[projectListGroup(project)]++;
  const matching = projects.filter(
    (project) =>
      show.has(projectListGroup(project)) && (!query || project.name.toLowerCase().includes(query)),
  );
  const rows = await Promise.all(
    matching.map(async (project) => {
      const repository = repositories.find((row) => row.id === project.id);
      const ready =
        !!repository?.repositoryPath && (repository.repositoryStatus || 'ready') === 'ready';
      const newest = ready
        ? await repositoryRefs
            .read(repository.repositoryPath)
            .then((snapshot) =>
              snapshot.refs
                .filter((ref) => ref.name.startsWith('refs/heads/') && ref.updatedAt)
                .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
                .at(0),
            )
            .catch(() => undefined)
        : undefined;
      const openPulls = pulls.filter(
        (pull) => pull.projectId === project.id && (pull.state || pull.status || 'open') === 'open',
      ).length;
      return {
        project: {
          ...project,
          ...(newest ? { changedAt: newest.updatedAt } : {}),
          ...(openPulls ? { openPulls } : {}),
        } as Project,
        path: ready ? (repository.repositoryPath as string) : undefined,
        commit: newest?.oid,
      };
    }),
  );
  rows.sort(
    (a, b) =>
      Date.parse(b.project.changedAt || '') - Date.parse(a.project.changedAt || '') ||
      Number(!!b.project.changedAt) - Number(!!a.project.changedAt) ||
      a.project.name.localeCompare(b.project.name),
  );
  const of = (group: ProjectListGroup) =>
    rows.filter((row) => projectListGroup(row.project) === group);
  const every = of('repositories');
  const page = await Promise.all(
    every.slice(0, limit).map(async ({ project, path, commit }) => {
      const lastCommit =
        path && commit
          ? await commitText(path, ['show', '-s', '--format=%s', commit]).catch(() => '')
          : '';
      return lastCommit ? { ...project, lastCommit } : project;
    }),
  );
  return {
    live: of('live').map((row) => row.project),
    repositories: page,
    archived: of('archived').map((row) => row.project),
    more: Math.max(0, every.length - limit),
    counts,
  };
}
