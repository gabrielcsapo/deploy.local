import type { ProjectListGroup, ProjectListResponse } from '../../../shared/v2/contracts.ts';
import { projectListOptions, projectListPath } from '../../../shared/v2/project-list.ts';
import { projectList } from '../../features/repositories/project-list.ts';
import { hourlyRequests } from './requests.ts';

export { projectListOptions, projectListPath };

/** The Projects page: the list, with the last 24 hours of requests on each project with a web app. */
export async function readProjectList(
  owner: string,
  options: { show?: ProjectListGroup[]; query?: string; limit?: number } = projectListOptions(
    new URLSearchParams(),
  ),
  now = Date.now(),
): Promise<ProjectListResponse> {
  const list = await projectList(owner, options);
  const web = list.live.flatMap((project) =>
    project.apps.filter((app) => app.kind === 'web').map((app) => app.name),
  );
  const { from, hours } = hourlyRequests(web, now);
  return {
    ...list,
    live: list.live.map((project) => {
      const series = project.apps.flatMap((app) => {
        const hourly = hours.get(app.name);
        return hourly ? [hourly] : [];
      });
      return series.length
        ? {
            ...project,
            traffic: {
              from,
              hourly: series[0].map((_, hour) => series.reduce((sum, app) => sum + app[hour], 0)),
            },
          }
        : project;
    }),
  };
}
