import type { Project } from '../../shared/v2/contracts.ts';
import { getDeployments, getApplicationSpecRevision } from '../store.ts';
import { list } from '../workspace/store.ts';
import { repositoryInfo } from '../workspace/repositories.ts';
import { parseStoredApplicationSpec } from '../application-spec.ts';
import { fail } from './inbox.ts';

export type ProjectApplication = { id: string; name: string; kind: 'web' | 'worker' };

/** The application-repositories relation is the sole source of workspace membership. */
export function groupProjects(
  projects: { id: string; name: string }[],
  apps: ProjectApplication[],
  links: { projectId: string; application: string }[],
): Project[] {
  const result = projects.map((project) => ({ ...project, apps: [] as ProjectApplication[] }));
  for (const app of apps) {
    const matches = result.filter((project) =>
      links.some((link) => link.projectId === project.id && link.application === app.name),
    );
    if (matches.length > 1) fail(`App ${app.name} belongs to more than one project`, 409);
    if (matches[0]) matches[0].apps.push(app);
    else result.push({ id: `app:${app.id}`, name: app.name, apps: [app] });
  }
  return result;
}

export async function projectsForOwner(owner: string): Promise<Project[]> {
  const projects = list('project', owner).map(({ id, name }) => ({ id, name }));
  const links = [];
  for (const project of projects) {
    const repository = await repositoryInfo(owner, project.id);
    if ('deployment' in repository && repository.deployment.application)
      links.push({ projectId: project.id, application: repository.deployment.application });
  }
  const apps = getDeployments(owner).map((app) => {
    const revision = app.activeSpecDigest
      ? getApplicationSpecRevision(app.name, app.activeSpecDigest)
      : null;
    const spec = revision ? parseStoredApplicationSpec(revision.normalizedSpec) : null;
    const kind =
      spec &&
      !Object.keys(spec.routes).length &&
      Object.values(spec.components).some((component) => component.role === 'worker')
        ? ('worker' as const)
        : ('web' as const);
    return { id: app.name, name: app.name, kind };
  });
  return groupProjects(projects, apps, links);
}

export async function resolveProject(owner: string, key: string): Promise<Project> {
  const projects = await projectsForOwner(owner);
  const byId = projects.find((project) => project.id === key);
  if (byId) return byId;
  const matches = projects.filter((project) => project.name === key);
  if (matches.length > 1) fail('Project name is ambiguous; use its id', 409);
  if (!matches.length) fail('Project not found', 404);
  return matches[0];
}
