// encodeURIComponent leaves dots intact, but the dev RSC router treats any dot
// in a pathname as a static asset. Escape dots in resource segments as well.
export const projectSegment = (value: string) => encodeURIComponent(value).replaceAll('.', '%2E');
export const projectPath = (key: string) => `/dashboard/projects/${projectSegment(key)}`;
export function projectDocumentUrl(url: string) {
  const [path, ...query] = url.split('?');
  if (!/^\/dashboard\/projects\/[^/]+(?:\/|$)/.test(path)) return url;
  return path.replaceAll('.', '%2E') + (query.length ? `?${query.join('?')}` : '');
}
export function projectTabs(input: {
  code: boolean;
  pulls: number;
  issues: number;
  apps: number;
  releases: number;
  /** A one-app project is its own app page, so a web app's requests are a project tab. */
  requests?: boolean;
}) {
  return [
    'Overview',
    ...(input.code ? ['Code'] : []),
    ...(input.pulls ? ['Pull requests'] : []),
    ...(input.issues ? ['Issues'] : []),
    ...(input.apps > 1 ? ['Apps'] : []),
    ...(input.releases ? ['Releases'] : []),
    ...(input.apps === 1 && input.requests ? ['Requests'] : []),
    ...(input.apps ? ['Logs'] : []),
    'Settings',
  ];
}

/**
 * A project's tabs as every project page shows them, so switching tabs never changes the row.
 * Pull requests count the open ones, as the Pull requests page does.
 */
export function projectTabItems(
  base: string,
  overview:
    | {
        project: { apps: { kind?: string }[] };
        repository: unknown;
        pulls: { state?: string; status?: string }[];
        issues: unknown[];
      }
    | undefined,
  releases: number,
) {
  const open = overview?.pulls.filter((pull) => (pull.state ?? pull.status) === 'open').length;
  const apps = overview?.project.apps.length ?? 0;
  return projectTabs({
    code: !!overview?.repository,
    pulls: overview?.pulls.length ?? 0,
    issues: overview?.issues.length ?? 0,
    apps,
    releases,
    requests: overview?.project.apps[0]?.kind === 'web',
  }).map((label) => ({
    label,
    href:
      label === 'Overview'
        ? base
        : label === 'Apps'
          ? `${base}?tab=apps`
          : `${base}/${label === 'Pull requests' ? 'pulls' : label.toLowerCase()}`,
    ...(label === 'Apps'
      ? { count: apps }
      : label === 'Pull requests'
        ? { count: open || undefined }
        : label === 'Issues'
          ? { count: overview?.issues.length }
          : {}),
  }));
}
