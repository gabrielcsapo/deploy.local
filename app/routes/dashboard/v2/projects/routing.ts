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
}) {
  return [
    'Overview',
    ...(input.code ? ['Code'] : []),
    ...(input.pulls ? ['Pull requests'] : []),
    ...(input.issues ? ['Issues'] : []),
    ...(input.apps > 1 ? ['Apps'] : []),
    ...(input.releases ? ['Releases'] : []),
    ...(input.apps ? ['Logs'] : []),
    'Settings',
  ];
}
