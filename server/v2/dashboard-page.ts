import type { PageSeed } from './project-page.ts';
import { getUser, isAdmin } from '../store.ts';
import { list } from '../workspace/store.ts';
import { packageSidebar, readPackage, readPackages } from '../packages/api.ts';
import { copiesStatus } from '../packages/copies.ts';
import { npmRegistry } from '../packages/npm.ts';
import { listKeys } from '../packages/keys.ts';
import { readNodes } from '../api/fleet.ts';
import { catalogService } from '../api/catalog.ts';
import { handleCatalogRequest } from '../catalog/handler.ts';
import { readAccount } from './auth.ts';
import { devices } from './devices.ts';
import {
  agentsForOwner,
  rulesForOwner,
  approvalSuggestions,
  readAgentRuns,
  agentConversation,
  agentTracking,
} from './agents.ts';
import { coordinatorTimezone } from './agent-foundation.ts';
import { getComputers, getModels } from './computers.ts';
import { getLiveApp } from './live.ts';
import { projectsForOwner, resolveProject } from './projects.ts';
import { readProjectOverview } from './settings.ts';
import { sshServerInfo } from '../workspace/ssh-host.ts';
import { readDesktopManifest } from '../desktop-download.ts';
import { readTaskPage } from './tasks.ts';
import { diff as readTaskDiff } from '../workspace/service.ts';
import { approvedTaskDesign } from './design-check.ts';
import { backupService } from './backups.ts';
import {
  readDesignProjects,
  readDesignReviews,
  readDesignAsks,
  readDesignComments,
  readDesignPresence,
  readDesignProposals,
} from './design.ts';
import { projectReleases } from './releases.ts';

/** Seeds are request-owned. This helper neither caches data nor accepts client identity headers. */
async function put(seed: PageSeed, path: string, read: () => unknown) {
  try {
    // Use the wire representation, including JSON's omission of undefined properties.
    seed.data[path] = JSON.parse(JSON.stringify(await read()));
  } catch (error) {
    seed.errors[path] = error instanceof Error ? error.message : 'Request failed';
  }
}

/** Even presentation membership starts Git on a cold ready repository. */
export function canReadProjectMembership(owner: string) {
  return list('project', owner).every(
    (project) => (project.repositoryStatus || 'ready') !== 'ready',
  );
}

export async function loadShellResources(seed: PageSeed, url: URL) {
  const owner = seed.owner;
  await Promise.all([
    put(seed, '/api/v2/packages?sidebar=1', () => packageSidebar()),
    put(seed, '/api/user', () => getUser(owner)),
    put(seed, '/api/v2/agents', () => ({
      agents: agentsForOwner(owner),
      timezone: coordinatorTimezone(),
    })),
    put(seed, '/api/nodes', () => readNodes(owner)),
    put(seed, '/api/v2/auth/account', () => readAccount(owner)),
  ]);
  // Composers mount on these pages and read model choices before a menu is opened.
  if (
    /^\/dashboard\/?$/.test(url.pathname) ||
    /^\/dashboard\/(projects|tasks|agents|start|design)(\/|$)/.test(url.pathname)
  )
    await put(seed, '/api/v2/computers/models', () => getModels(owner));
  // /api/workspace/state probes Codex/Claude on a cold load; keep it in the browser.
}

/** Only first-render, process-free reads belong here. Streams and interactive reads stay client-side. */
export async function loadDashboardResources(seed: PageSeed, url: URL) {
  const owner = seed.owner;
  const [, area, key, section, item] = url.pathname
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent);
  const jobs: Promise<unknown>[] = [];
  const add = (path: string, read: () => unknown) => jobs.push(put(seed, path, read));
  if (['live', 'agents', 'design'].includes(area) && canReadProjectMembership(owner))
    add('/api/v2/projects', async () => ({ projects: await projectsForOwner(owner, true) }));
  if (area === 'live' && key && seed.data['/api/v2/live']) {
    const path = `/api/v2/live/${encodeURIComponent(key)}`;
    await put(seed, path, () =>
      getLiveApp(
        owner,
        key,
        seed.data['/api/v2/live'] as Awaited<ReturnType<typeof import('./live.ts').getLive>>,
      ),
    );
    const detail = seed.data[path] as Awaited<ReturnType<typeof getLiveApp>> | undefined;
    if (detail) {
      const project = detail.app.project || `app:${detail.app.name}`;
      add(`/api/v2/projects/${encodeURIComponent(project)}/overview`, async () =>
        readProjectOverview(owner, await resolveProject(owner, project, true)),
      );
    }
  }
  if (area === 'computers') {
    add('/api/v2/computers', () => ({ computers: getComputers(owner) }));
    if (key === 'models') add('/api/v2/computers/models', () => getModels(owner));
    // /updates and /self-update resolve Git revisions and may probe systemd on cold reads.
    if (key === 'add')
      add('/desktop/version', () => {
        const manifest = readDesktopManifest();
        if (!manifest) throw new Error('no-desktop-build');
        return manifest;
      });
  }
  if (area === 'agents' && key && key !== 'new') {
    if (section === 'tune')
      add('/api/v2/approvals', () => ({
        rules: rulesForOwner(owner),
        suggestions: approvalSuggestions(owner),
      }));
    else if (section === 'items' && item)
      add(`/api/v2/agents/${encodeURIComponent(key)}/items/${encodeURIComponent(item)}/runs`, () =>
        readAgentRuns(owner, key, item),
      );
    else
      // This finite snapshot is not the conversation/event stream.
      add(`/api/v2/agents/${encodeURIComponent(key)}/conversation`, () => ({
        events: agentConversation(owner, key),
        tracking: agentTracking(owner, key),
      }));
  }
  if (area === 'tasks' && key) {
    const task = list('task', owner).find((task) => task.id === key);
    // A task with no project has no repository, design check, or package comparison to read.
    if (task && !task.projectId && !approvedTaskDesign(owner, key))
      add(`/api/v2/tasks/${encodeURIComponent(key)}`, () => readTaskPage(owner, key));
    if (
      task &&
      ((task.workspaceStatus && task.workspaceStatus !== 'ready') ||
        (task.workerId && task.workerId !== 'local' && !task.workspaceCommit)) &&
      !list('pull-request', owner).some((pull) => pull.taskIds?.includes(key))
    )
      add(`/api/workspace/tasks/${encodeURIComponent(key)}/diff`, () => readTaskDiff(owner, key));
    if (task?.projectId && list('project', owner).some((project) => project.id === task.projectId))
      add(`/api/v2/projects/${encodeURIComponent(task.projectId)}/releases`, () => ({
        releases: projectReleases(owner, task.projectId),
      }));
  }
  if (area === 'design') {
    const review = url.searchParams.get('review');
    const project = review
      ? list('v2-inbox-native', owner).find((row) => row.id === review)?.context?.projectId
      : url.searchParams.get('project');
    if (
      project &&
      (review ||
        url.searchParams.get('view') === 'canvas' ||
        ['board', 'ref', 'task'].some((key) => url.searchParams.has(key)))
    ) {
      const base = `/api/v2/projects/${encodeURIComponent(project)}/design`;
      add(`${base}/asks?v=0`, () => readDesignAsks(owner, project));
      add(`${base}/comments`, () => readDesignComments(owner, project));
      add(`${base}/presence`, () => readDesignPresence(owner, project));
      add(`${base}/proposals?v=0`, () => readDesignProposals(owner, project));
    }
    const repositories = list('project', owner).filter((project) => project.repositoryPath);
    if (!repositories.length) {
      add('/api/v2/design/projects', () => readDesignProjects(owner));
      const waiting = (seed.data['/api/v2/inbox?state=waiting'] as { items: { id: string }[] })
        .items;
      const version = waiting
        .filter((item) => item.id.startsWith('design:'))
        .map((item) => item.id)
        .join(',');
      if (!version) {
        const filter = url.searchParams.get('project');
        const path = `/api/v2/design/reviews?${filter ? `project=${encodeURIComponent(filter)}&` : ''}v=${encodeURIComponent(version)}`;
        add(path, () => readDesignReviews(owner, new URL(path, url.origin)));
      }
    }
  }
  if (area === 'packages') {
    if (!key && url.searchParams.get('tab') === 'copies')
      add('/api/v2/packages/cache', () => copiesStatus(owner, npmRegistry.copy));
    // usedBy reads Git even for a non-ready repository; package membership is global.
    if (!list('project', owner).some((project) => project.repositoryPath)) {
      if (!key) add('/api/v2/packages', () => readPackages(owner));
      else {
        const name = decodeURIComponent(url.pathname.slice('/dashboard/packages/npm/'.length));
        const path = `/api/v2/packages/npm/${encodeURIComponent(name)}`;
        add(path, () => readPackage(owner, encodeURIComponent(name)));
      }
    }
  }
  if (area === 'settings') {
    if (!key) add('/api/v2/package-keys', () => ({ keys: listKeys(owner) }));
    if (key === 'approvals')
      add('/api/v2/approvals', () => ({
        rules: rulesForOwner(owner),
        suggestions: approvalSuggestions(owner),
      }));
    if (key === 'devices') add('/api/v2/devices', () => ({ devices: devices(owner) }));
    if (key === 'account')
      add('/api/workspace/ssh-keys', () => ({
        keys: list('ssh-key', owner),
        server: sshServerInfo(),
      }));
    if (
      key === 'backups' &&
      canReadProjectMembership(owner) &&
      !list('v2-backup-restore', owner).length
    )
      add('/api/v2/backups', () => backupService.listing(owner));
    // Backups' full listing resolves project membership and may publish a restore.
  }
  if (area === 'discover' || (area === 'start' && key === 'apps')) {
    const read = async (path: string) => {
      // The HTTP route's requireAdmin guard runs before the catalog handler.
      if (!isAdmin(owner)) throw new Error('Administrator access required');
      const response = await handleCatalogRequest(catalogService, {
        method: 'GET',
        pathname: path.slice('/api'.length),
        actor: { username: owner, role: 'admin' },
      });
      if (response.status !== 200) throw new Error((response.body as { error: string }).error);
      return response.body;
    };
    await put(seed, '/api/catalog', () => read('/api/catalog'));
    const catalog = seed.data['/api/catalog'] as
      | { releases: { id: string; release: string }[] }
      | undefined;
    const selected = area === 'discover' && catalog?.releases.find((release) => release.id === key);
    if (selected) {
      const path = `/api/catalog/${encodeURIComponent(selected.id)}/${encodeURIComponent(selected.release)}`;
      add(path, () => read(path));
    }
    // /api/catalog/targets starts Docker CLI probes; never await it for HTML.
  }
  await Promise.all(jobs);
}
