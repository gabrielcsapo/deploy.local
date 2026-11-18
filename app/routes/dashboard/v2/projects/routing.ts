import type { LiveApp } from '../../../../../shared/v2/contracts';
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
  apps: number;
  releases: number;
  /** A one-app project is its own app page, so a web app's requests are a project tab. */
  requests?: boolean;
  pipeline?: boolean;
}) {
  return [
    'Overview',
    // Work takes the place of Issues and Pull requests, on every project.
    'Work',
    ...(input.code ? ['Code'] : []),
    ...(input.apps > 1 || (input.pipeline && input.apps > 0) ? ['Apps'] : []),
    ...(input.pipeline ? ['Pipelines'] : []),
    ...(input.releases || input.apps === 1 ? ['Releases'] : []),
    ...(input.apps === 1 && input.requests ? ['Requests'] : []),
    ...(input.apps === 1 && input.requests ? ['Performance'] : []),
    ...(input.apps ? ['Logs'] : []),
    'Settings',
  ];
}

/**
 * A project's tabs as every project page shows them, so switching tabs never changes the row.
 * Work counts what is open, as the Work tab's Open switch does.
 */
export function projectTabItems(
  base: string,
  overview:
    | {
        project: { apps: { name: string; kind?: string }[] };
        repository: { deployment?: { pipeline?: boolean } } | null;
      }
    | undefined,
  releases: number,
  openWork?: number,
) {
  const apps = overview?.project.apps.length ?? 0;
  const appTabs = apps === 1 ? appTabItems(base, overview!.project.apps[0], true) : [];
  return projectTabs({
    code: !!overview?.repository,
    pipeline: !!overview?.repository?.deployment?.pipeline,
    apps,
    releases,
    requests: overview?.project.apps[0]?.kind === 'web',
  }).map((label) => ({
    label,
    href:
      appTabs.find((tab) => tab.label === label)?.href ??
      (label === 'Overview'
        ? base
        : label === 'Apps'
          ? `${base}?tab=apps`
          : `${base}/${label.toLowerCase()}`),
    ...(label === 'Apps'
      ? { count: apps }
      : label === 'Work'
        ? { count: openWork || undefined }
        : {}),
  }));
}

/** Every Live link resolves inside Projects, including standalone/Discover apps. */
export function appPath(app: Pick<LiveApp, 'project' | 'name' | 'appId'>) {
  return `${projectPath(app.project || `app:${app.name}`)}/apps/${projectSegment(app.appId)}`;
}

export function appTabItems(base: string, app: { name: string; kind?: string }, single = false) {
  const appBase = `${base}/apps/${projectSegment(app.name)}`;
  const query = `?app=${encodeURIComponent(app.name)}`;
  return [
    { label: 'Overview', href: single ? base : appBase },
    ...(app.kind === 'worker'
      ? []
      : [
          { label: 'Requests', href: `${single ? base : appBase}/requests` },
          { label: 'Performance', href: `${single ? base : appBase}/performance` },
        ]),
    { label: 'Releases', href: `${base}/releases${query}` },
    { label: 'Logs', href: `${base}/logs${query}` },
    { label: 'Settings', href: `${single ? base : appBase}/settings` },
  ];
}

/** The old Issues and Pull requests lists are one Work tab now; their addresses land there. */
export function workRedirect({ url }: { url: URL }) {
  return url.pathname.replace(/\/(?:issues|pulls)\/?$/, '/work') + url.search + url.hash;
}
