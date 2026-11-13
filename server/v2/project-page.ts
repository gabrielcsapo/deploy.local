import { loadDashboardResources, loadShellResources } from './dashboard-page.ts';
import { authenticate, getNodes } from '../store.ts';
import { parseAuthCookie } from '../auth-cookie.ts';
import { projectsForOwner, resolveProject } from './projects.ts';
import { readProjectOverview, readProjectSettings } from './settings.ts';
import { projectReleases, projectRollbacks } from './releases.ts';
import { getLive, getLiveApp } from './live.ts';
import { readWorkspaceState } from '../workspace/read-state.ts';
import { collaborationRead } from '../workspace/project-collaboration.ts';
import { repositoryInfo, repositoryRead } from '../workspace/repositories.ts';
import { pipelineRead } from '../workspace/pipelines.ts';
import {
  requestSummary,
  requestList,
  requestDetail,
  type RequestRange,
  type RequestShow,
} from './requests.ts';
import { readPerformance } from '../telemetry.ts';
import { getRequestsSqlite } from '../requests-db.ts';
import { syncInbox } from './inbox.ts';
import { cursor } from '../workspace/store.ts';
import { projectLogSources } from './logs.ts';
import type { Project } from '../../shared/v2/contracts.ts';

export type PageSeed = {
  owner: string;
  at: number;
  origin: string;
  timeZone: string;
  cursor: number;
  coordinatorName: string;
  errors: Record<string, string>;
  data: Record<string, unknown>;
};
export function dashboardPageURL(request?: Request) {
  if (!request) return undefined;
  const url = new URL(request.url);
  // RSC requests carry the destination in url; document requests use their own path.
  const target =
    url.pathname === '/__rsc' ? new URL(url.searchParams.get('url') || '/', url.origin) : url;
  return /^\/dashboard(?:\/|$)/.test(target.pathname) ? target : undefined;
}
export function projectPageURL(request?: Request) {
  const url = dashboardPageURL(request);
  return url && /^\/dashboard\/projects(?:\/|$)/.test(url.pathname) ? url : undefined;
}
export function projectPageOwner(request?: Request) {
  if (!request) return undefined;
  const { username, token } = parseAuthCookie({
    headers: { cookie: request.headers.get('cookie') ?? undefined },
  });
  // Headers/local storage never supply a server render's identity.
  try {
    return authenticate(username, token) ? username : undefined;
  } catch {
    return undefined;
  }
}

type Repository = { deployment?: { pipeline?: boolean }; defaultBranch?: string; empty?: boolean };
type Page = {
  seed: PageSeed;
  project?: Project;
  overview?: Awaited<ReturnType<typeof readProjectOverview>>;
  url: URL;
};
const requests = new WeakMap<Request, Promise<Page | undefined>>();
/** Request lifetime only: no shared URL cache can carry one owner's data to another. */
export function loadProjectPage(request?: Request): Promise<Page | undefined> {
  return projectPageURL(request) ? loadDashboardPage(request) : Promise.resolve(undefined);
}
export function loadDashboardPage(request?: Request): Promise<Page | undefined> {
  if (!request) return Promise.resolve(undefined);
  let pending = requests.get(request);
  if (!pending) {
    pending = load(request);
    requests.set(request, pending);
  }
  return pending;
}
async function load(request: Request): Promise<Page | undefined> {
  const url = dashboardPageURL(request),
    owner = projectPageOwner(request);
  if (!url || !owner) return undefined;
  const seed: PageSeed = {
    owner,
    at: Date.now(),
    origin: url.origin,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    cursor: cursor(owner),
    coordinatorName: getNodes().find((n) => n.id === 'coordinator')?.name || 'the coordinator',
    errors: {},
    data: {},
  };
  const put = async (path: string, read: () => unknown) => {
    try {
      seed.data[path] = await read();
    } catch (error) {
      seed.errors[path] = error instanceof Error ? error.message : 'Request failed';
    }
  };
  // Health collection/inbox synchronization can themselves publish events. Establish the
  // replay boundary afterwards, before reading the page's stored data.
  await loadShellResources(seed, url);
  const projectsPage = !!projectPageURL(request);
  // The sidebar shows running apps and tasks on every page.
  await put('/api/v2/live', () => getLive(owner));
  const items = syncInbox(owner);
  seed.cursor = cursor(owner);
  for (const state of ['waiting', 'answered'])
    seed.data[`/api/v2/inbox?state=${state}`] = {
      items: items.filter((item) => item.state === state),
      cursor: seed.cursor,
    };
  if (!projectsPage) {
    await Promise.all([
      put('/api/workspace/state', () => readWorkspaceState(owner)),
      loadDashboardResources(seed, url),
    ]);
    return { seed, url };
  }
  const projects = await projectsForOwner(owner, true).catch(() => undefined);
  if (!projects) return undefined;
  seed.data['/api/v2/projects'] = { projects };
  const key = decodeURIComponent(url.pathname.split('/')[3] || '');
  const project =
    projects.find((entry) => entry.id === key) ??
    (key ? await resolveProject(owner, key, true).catch(() => undefined) : undefined);
  await put('/api/workspace/state', () => readWorkspaceState(owner));
  if (!key || !project) return { seed, url };
  const base = `/api/v2/projects/${encodeURIComponent(key)}`;
  await Promise.all([
    put(`${base}/overview`, () => readProjectOverview(owner, project)),
    put(`${base}/releases`, () => ({ releases: projectReleases(owner, project.id) })),
    put(`/api/workspace/projects/${encodeURIComponent(key)}/pulls?status=open`, () =>
      collaborationRead(
        owner,
        project.id,
        'pulls',
        undefined,
        undefined,
        new URLSearchParams('status=open'),
      ),
    ),
  ]);
  // The unlinked-app picker is mounted with the header. Reuse the membership read.
  seed.data['/api/v2/projects/unlinked-apps'] = {
    apps: projects.filter((p) => p.id.startsWith('app:') && !p.fromDiscover).flatMap((p) => p.apps),
  };
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const selected =
    parts[3] === 'apps'
      ? project.apps.find((app) => app.name === parts[4] || app.id === parts[4])
      : project.apps.length === 1
        ? project.apps[0]
        : undefined;
  const requestId =
    parts[3] === 'requests' ? parts[4] : parts[5] === 'requests' ? parts[6] : undefined;
  if (selected && requestId)
    await put(
      `/api/v2/apps/${encodeURIComponent(selected.name)}/requests/${encodeURIComponent(requestId)}`,
      () => requestDetail(owner, selected.name, Number(requestId)),
    );
  return { seed, project, overview: seed.data[`${base}/overview`] as Page['overview'], url };
}

/** Tab reads are separate from the header and stream under ProjectPanel's boundary. */
export async function loadProjectTab(page?: Page): Promise<PageSeed | undefined> {
  if (!page) return undefined;
  const { project, overview, url } = page;
  const seed = { ...page.seed, data: { ...page.seed.data }, errors: { ...page.seed.errors } };
  if (!project) return seed;
  const owner = seed.owner,
    parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const section = parts[3] || '',
    params = url.searchParams;
  const base = `/api/v2/projects/${encodeURIComponent(parts[2])}`;
  const canonicalBase = `/api/v2/projects/${encodeURIComponent(project.id)}`;
  const repo = `/api/workspace/projects/${encodeURIComponent(project.id)}/repository`;
  const put = async <T>(path: string, read: () => T | Promise<T>): Promise<T | undefined> => {
    try {
      const data = await read();
      seed.data[path] = data;
      return data;
    } catch (error) {
      seed.errors[path] = error instanceof Error ? error.message : 'Request failed';
      return undefined;
    }
  };
  const app =
    section === 'apps'
      ? project.apps.find((a) => a.id === parts[4] || a.name === parts[4])
      : project.apps.length === 1
        ? project.apps[0]
        : undefined;
  const tab = section === 'apps' ? parts[5] || '' : section;
  const jobs: Promise<unknown>[] = [];
  if (app && ['', 'settings'].includes(tab))
    jobs.push(
      put(`/api/v2/live/${encodeURIComponent(app.name)}`, () =>
        getLiveApp(
          owner,
          app.name,
          seed.data['/api/v2/live'] as Awaited<ReturnType<typeof getLive>>,
        ),
      ),
    );
  if (tab === 'settings') {
    jobs.push(put(`${canonicalBase}/settings`, () => readProjectSettings(owner, project)));
    if (overview?.repository) jobs.push(put(repo, () => repositoryInfo(owner, project.id, true)));
  }
  if (section === 'releases')
    jobs.push(put(`${base}/rollbacks`, () => ({ rollbacks: projectRollbacks(owner, project.id) })));
  if (section === 'pulls') {
    const pulls = `/api/workspace/projects/${encodeURIComponent(parts[2])}/pulls`;
    if (parts[4]) {
      const path = `${pulls}/${encodeURIComponent(parts[4])}`;
      jobs.push(put(path, () => collaborationRead(owner, project.id, 'pulls', parts[4])));
      jobs.push(
        put(`${path}/diff`, () => collaborationRead(owner, project.id, 'pulls', parts[4], 'diff')),
      );
    } else
      for (const query of ['status=open&q=', 'status=merged&limit=5&q='])
        jobs.push(
          put(`${pulls}?${query}`, () =>
            collaborationRead(
              owner,
              project.id,
              'pulls',
              undefined,
              undefined,
              new URLSearchParams(query),
            ),
          ),
        );
  }
  if (
    section === 'pipelines' &&
    overview?.repository &&
    'deployment' in overview.repository &&
    (overview.repository as Repository).deployment?.pipeline
  ) {
    const path = `/api/workspace/projects/${encodeURIComponent(project.id)}/pipelines`;
    const runs = await put(path, () => pipelineRead(owner, project.id));
    const id = runs && 'runs' in runs ? runs.runs?.[0]?.id : undefined;
    if (id)
      jobs.push(
        put(`${path}/${encodeURIComponent(id)}`, () => pipelineRead(owner, project.id, id)),
      );
  }
  if (
    section === 'code' &&
    overview?.repository &&
    !('empty' in overview.repository && overview.repository.empty)
  ) {
    jobs.push(put(repo, () => repositoryInfo(owner, project.id, true)));
    const ref = params.get('ref') || (overview.repository as Repository).defaultBranch || 'HEAD';
    const file = params.get('file') || '',
      path = params.get('path') || '';
    const query = `ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(file || path)}`;
    const action = file ? 'blob' : 'tree';
    const result: any = await put(`${repo}/${action}?${query}`, () =>
      repositoryRead(owner, project.id, action, new URLSearchParams(query)),
    );
    if (result && 'commit' in result) {
      const readme =
        'entries' in result
          ? result.entries.find((e: { name: string }) =>
              /^readme(?:\.md|\.markdown)?$/i.test(e.name),
            )
          : undefined;
      if (!file && readme) {
        const query = `ref=${result.commit}&path=${encodeURIComponent(readme.path)}`;
        jobs.push(
          put(`${repo}/blob?${query}`, () =>
            repositoryRead(owner, project.id, 'blob', new URLSearchParams(query)),
          ),
        );
      }
      if (params.has('history')) {
        const query = `ref=${result.commit}&path=${encodeURIComponent(file || path)}&limit=100`;
        jobs.push(
          put(`${repo}/history?${query}`, () =>
            repositoryRead(owner, project.id, 'history', new URLSearchParams(query)),
          ),
        );
      }
    }
  }
  if (app && tab === 'requests') {
    const path = `/api/v2/apps/${encodeURIComponent(app.name)}/requests`;
    const id = section === 'apps' ? parts[6] : parts[4];
    if (id)
      jobs.push(
        put(`${path}/${encodeURIComponent(id)}`, () => requestDetail(owner, app.name, Number(id))),
      );
    else {
      const range = (
        ['1h', '24h', '7d', '30d'].includes(params.get('range') || '') ? params.get('range') : '24h'
      ) as RequestRange;
      const show = (
        ['all', 'server', 'client', 'slow'].includes(params.get('show') || '')
          ? params.get('show')
          : 'all'
      ) as RequestShow;
      const page = Math.max(1, Number(params.get('page')) || 1),
        filter = params.get('path') ?? '';
      jobs.push(
        put(`${path}/summary?range=${range}`, () => requestSummary(owner, app.name, range)),
      );
      jobs.push(
        put(
          `${path}?range=${range}&show=${show}&page=${page}&path=${encodeURIComponent(filter)}`,
          () => requestList(owner, app.name, { range, show, page, path: filter }),
        ),
      );
    }
  }
  if (app && tab === 'performance') {
    const range = (
      ['1h', '24h', '7d'].includes(params.get('range') || '') ? params.get('range') : '24h'
    ) as '1h' | '24h' | '7d';
    jobs.push(
      put(`/api/v2/apps/${encodeURIComponent(app.name)}/performance?range=${range}`, () =>
        readPerformance(getRequestsSqlite(), app.name, range),
      ),
    );
  }
  if (section === 'logs') {
    const selected = params.get('app') || '';
    seed.data[`${canonicalBase}/logs?app=${encodeURIComponent(selected)}`] = {
      sources: projectLogSources(project, selected),
    };
  }
  await Promise.all(jobs);
  return seed;
}
