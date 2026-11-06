import type { RouteConfig } from 'react-flight-router/router';

export const routes: RouteConfig[] = [
  {
    id: 'root',
    path: '',
    component: () => import('./root.js'),
    notFound: () => import('./routes/not-found.js'),
    error: () => import('./routes/error.js'),
    children: [
      {
        id: 'home',
        index: true,
        component: () => import('./routes/v2-public/page.js'),
      },
      { id: 'signin', path: 'signin', component: () => import('./routes/v2-public/page.js') },
      { id: 'setup', path: 'setup', component: () => import('./routes/v2-public/page.js') },
      { id: 'recover', path: 'recover', component: () => import('./routes/v2-public/page.js') },
      {
        id: 'discover',
        path: 'discover',
        component: () => import('./routes/dashboard/v2-redirect.js'),
      },
      {
        id: 'about',
        path: 'about',
        component: () => import('./routes/home.js'),
      },
      {
        id: 'changelog',
        path: 'changelog',
        component: () => import('./routes/changelog.js'),
      },
      {
        id: 'docs',
        path: 'docs',
        component: () => import('./routes/docs/layout.js'),
        children: [
          {
            id: 'docs-index',
            index: true,
            component: () => import('./routes/docs/index.js'),
          },
          {
            id: 'docs-install',
            path: 'install',
            component: () => import('./routes/docs/install.js'),
          },
          {
            id: 'docs-devices',
            path: 'devices',
            component: () => import('./routes/docs/devices.js'),
          },
          {
            id: 'docs-screenshots',
            path: 'screenshots',
            component: () => import('./routes/docs/screenshots.js'),
          },
          {
            id: 'docs-releases',
            path: 'releases',
            component: () => import('./routes/docs/releases.js'),
          },
          {
            id: 'docs-projects',
            path: 'projects',
            component: () => import('./routes/docs/projects.js'),
          },
          {
            id: 'docs-backups',
            path: 'backups',
            component: () => import('./routes/docs/backups.js'),
          },
          {
            id: 'docs-updates',
            path: 'updates',
            component: () => import('./routes/docs/updates.js'),
          },
          {
            id: 'docs-agents',
            path: 'agents',
            component: () => import('./routes/docs/agents.js'),
          },
          {
            id: 'docs-approvals',
            path: 'approvals',
            component: () => import('./routes/docs/approvals.js'),
          },
          {
            id: 'docs-models',
            path: 'models',
            component: () => import('./routes/docs/models.js'),
          },
          {
            id: 'docs-deploying',
            path: 'deploying',
            component: () => import('./routes/dashboard/v2-redirect.js'),
          },
          {
            id: 'docs-ship',
            path: 'ship',
            component: () => import('./routes/docs/ship.js'),
          },
          {
            id: 'docs-configuration',
            path: 'configuration',
            component: () => import('./routes/dashboard/v2-redirect.js'),
          },
          {
            id: 'docs-deploy-yaml',
            path: 'deploy-yaml',
            component: () => import('./routes/docs/deploy-yaml.js'),
          },
          {
            id: 'docs-managing',
            path: 'managing',
            component: () => import('./routes/dashboard/v2-redirect.js'),
          },
          {
            id: 'docs-live',
            path: 'live',
            component: () => import('./routes/docs/live.js'),
          },
          {
            id: 'docs-nodes',
            path: 'nodes',
            component: () => import('./routes/dashboard/v2-redirect.js'),
          },
          {
            id: 'docs-computers',
            path: 'computers',
            component: () => import('./routes/docs/computers.js'),
          },
          {
            id: 'docs-cli',
            path: 'cli',
            component: () => import('./routes/docs/cli.js'),
          },
          {
            id: 'docs-architecture',
            path: 'architecture',
            component: () => import('./routes/docs/architecture.js'),
          },
          {
            id: 'docs-roadmap',
            path: 'roadmap',
            component: () => import('./routes/dashboard/v2-redirect.js'),
          },
          {
            id: 'docs-ask',
            path: 'ask',
            component: () => import('./routes/docs/ask.js'),
          },
          {
            id: 'docs-troubleshooting',
            path: 'troubleshooting',
            component: () => import('./routes/docs/troubleshooting.js'),
          },
        ],
      },
      {
        id: 'packages-short',
        path: 'packages',
        component: () => import('./routes/dashboard/v2-redirect.js'),
      },
      {
        id: 'package-short',
        path: 'packages/npm/:name',
        component: () => import('./routes/dashboard/v2-redirect.js'),
      },
      {
        id: 'package-short-scoped',
        path: 'packages/npm/:scope/:name',
        component: () => import('./routes/dashboard/v2-redirect.js'),
      },
      // The workspace: `/dashboard/...` and repository short addresses share one layout, so moving
      // between tasks and a repository keeps it mounted. Last, so every page above wins.
      {
        id: 'dashboard',
        path: 'dashboard',
        component: () => import('./routes/dashboard/v2/start/layout.js'),
        children: [
          {
            id: 'dashboard-index',
            index: true,
            component: () => import('./routes/dashboard/v2/start/home.js'),
          },
          {
            id: 'dashboard-design-system',
            path: 'design-system',
            component: () => import('./routes/dashboard/design-system.js'),
          },
          {
            id: 'v2-design',
            path: 'design',
            component: () => import('./routes/dashboard/v2/design/page.js'),
          },
          {
            id: 'v2-inbox',
            path: 'inbox',
            component: () => import('./routes/dashboard/v2/inbox/page.js'),
          },
          {
            id: 'v2-live',
            path: 'live',
            component: () => import('./routes/dashboard/v2/live/page.js'),
          },
          {
            id: 'v2-live-app',
            path: 'live/:app',
            component: () => import('./routes/dashboard/v2/live/page.js'),
          },
          {
            id: 'v2-tasks-id',
            path: 'tasks/:id',
            component: () => import('./routes/dashboard/v2/tasks/page.js'),
          },
          {
            id: 'v2-tasks-id-changes',
            path: 'tasks/:id/changes',
            component: () => import('./routes/dashboard/v2/tasks/page.js'),
          },
          {
            id: 'v2-tasks-id-checks',
            path: 'tasks/:id/checks',
            component: () => import('./routes/dashboard/v2/tasks/page.js'),
          },
          {
            id: 'v2-tasks-id-design',
            path: 'tasks/:id/design',
            component: () => import('./routes/dashboard/v2/tasks/page.js'),
          },
          {
            id: 'v2-projects',
            path: 'projects',
            component: () => import('./routes/dashboard/v2/projects/page.js'),
          },
          {
            id: 'v2-projects-p',
            path: 'projects/:p',
            component: () => import('./routes/dashboard/v2/projects/page.js'),
          },
          {
            id: 'v2-projects-p-code',
            path: 'projects/:p/code',
            component: () => import('./routes/dashboard/v2/projects/page.js'),
          },
          {
            id: 'v2-projects-p-pulls',
            path: 'projects/:p/pulls',
            component: () => import('./routes/dashboard/v2/tasks/pulls.js'),
          },
          {
            id: 'v2-projects-p-pulls-id',
            path: 'projects/:p/pulls/:id',
            component: () => import('./routes/dashboard/v2/tasks/pulls.js'),
          },
          {
            id: 'v2-projects-p-issues',
            path: 'projects/:p/issues',
            component: () => import('./routes/dashboard/v2/projects/page.js'),
          },
          {
            id: 'v2-projects-p-apps-app',
            path: 'projects/:p/apps/:app',
            component: () => import('./routes/dashboard/v2/projects/page.js'),
          },
          {
            id: 'v2-projects-p-apps-app-settings',
            path: 'projects/:p/apps/:app/settings',
            component: () => import('./routes/dashboard/v2/projects/page.js'),
          },
          {
            id: 'v2-projects-p-requests',
            path: 'projects/:p/requests',
            component: () => import('./routes/dashboard/v2/projects/page.js'),
          },
          {
            id: 'v2-projects-p-request',
            path: 'projects/:p/requests/:id',
            component: () => import('./routes/dashboard/v2/projects/page.js'),
          },
          {
            id: 'v2-projects-p-apps-app-requests',
            path: 'projects/:p/apps/:app/requests',
            component: () => import('./routes/dashboard/v2/projects/page.js'),
          },
          {
            id: 'v2-projects-p-apps-app-request',
            path: 'projects/:p/apps/:app/requests/:id',
            component: () => import('./routes/dashboard/v2/projects/page.js'),
          },
          {
            id: 'v2-projects-p-releases',
            path: 'projects/:p/releases',
            component: () => import('./routes/dashboard/v2/releases/page.js'),
          },
          {
            id: 'v2-projects-p-releases-id',
            path: 'projects/:p/releases/:id',
            component: () => import('./routes/dashboard/v2/releases/page.js'),
          },
          {
            id: 'v2-projects-p-logs',
            path: 'projects/:p/logs',
            component: () => import('./routes/dashboard/v2/projects/page.js'),
          },
          {
            id: 'v2-projects-p-settings',
            path: 'projects/:p/settings',
            component: () => import('./routes/dashboard/v2/projects/page.js'),
          },
          {
            id: 'v2-computers',
            path: 'computers',
            component: () => import('./routes/dashboard/v2/computers/page.js'),
          },
          {
            id: 'v2-computers-models',
            path: 'computers/models',
            component: () => import('./routes/dashboard/v2/computers/page.js'),
          },
          {
            id: 'v2-computers-add',
            path: 'computers/add',
            component: () => import('./routes/dashboard/v2/computers/page.js'),
          },
          {
            id: 'v2-computers-id',
            path: 'computers/:id',
            component: () => import('./routes/dashboard/v2/computers/page.js'),
          },
          {
            id: 'v2-agents-new',
            path: 'agents/new',
            component: () => import('./routes/dashboard/v2/agents/page.js'),
          },
          {
            id: 'v2-agents',
            path: 'agents',
            component: () => import('./routes/dashboard/v2/agents/page.js'),
          },
          {
            id: 'v2-agents-agent',
            path: 'agents/:agent',
            component: () => import('./routes/dashboard/v2/agents/page.js'),
          },
          {
            id: 'v2-agents-item-history',
            path: 'agents/:agent/items/:item/history',
            component: () => import('./routes/dashboard/v2/agents/page.js'),
          },
          {
            id: 'v2-agents-agent-tune',
            path: 'agents/:agent/tune',
            component: () => import('./routes/dashboard/v2/agents/page.js'),
          },
          {
            id: 'v2-start',
            path: 'start',
            component: () => import('./routes/dashboard/v2/start/page.js'),
          },
          {
            id: 'v2-start-project',
            path: 'start/project',
            component: () => import('./routes/dashboard/v2/start/page.js'),
          },
          {
            id: 'v2-start-apps',
            path: 'start/apps',
            component: () => import('./routes/dashboard/v2/start/page.js'),
          },
          {
            id: 'v2-settings-account',
            path: 'settings/account',
            component: () => import('./routes/dashboard/v2/start/account.js'),
          },
          {
            id: 'v2-devices',
            path: 'settings/devices',
            component: () => import('./routes/dashboard/v2/start/account.js'),
          },
          {
            id: 'v2-packages',
            path: 'packages',
            component: () => import('./routes/dashboard/v2/packages/page.js'),
          },
          {
            id: 'v2-package',
            path: 'packages/npm/:name',
            component: () => import('./routes/dashboard/v2/packages/page.js'),
          },
          {
            id: 'v2-scoped-package',
            path: 'packages/npm/:scope/:name',
            component: () => import('./routes/dashboard/v2/packages/page.js'),
          },
          {
            id: 'v2-settings',
            path: 'settings',
            component: () => import('./routes/dashboard/v2/settings/page.js'),
          },
          {
            id: 'v2-settings-approvals',
            path: 'settings/approvals',
            component: () => import('./routes/dashboard/v2/settings/page.js'),
          },
          {
            id: 'v2-settings-backups',
            path: 'settings/backups',
            component: () => import('./routes/dashboard/v2/settings/backups/page.js'),
          },
          {
            id: 'v2-discover',
            path: 'discover',
            component: () => import('./routes/dashboard/v2/start/page.js'),
          },
          {
            id: 'v2-discover-import',
            path: 'discover/import',
            component: () => import('./routes/dashboard/v2-placeholder.js'),
          },
          {
            id: 'v2-discover-blueprint',
            path: 'discover/:blueprint',
            component: () => import('./routes/dashboard/v2/start/page.js'),
          },
          {
            id: 'legacy-repositories',
            path: 'repositories',
            component: () => import('./routes/dashboard/v2-redirect.js'),
          },
          {
            id: 'legacy-repository',
            path: 'repositories/:projectId',
            component: () => import('./routes/dashboard/v2-redirect.js'),
          },
          {
            id: 'legacy-repository-section',
            path: 'repositories/:projectId/:section',
            component: () => import('./routes/dashboard/v2-redirect.js'),
          },
          {
            id: 'dashboard-embed-computers',
            path: 'embed/computers',
            component: () => import('./routes/dashboard/embed-permissions.js'),
          },
          {
            id: 'dashboard-embed-computer',
            path: 'embed/computers/:workerId',
            component: () => import('./routes/dashboard/embed-permissions.js'),
          },
          {
            id: 'legacy-apps',
            path: 'apps',
            component: () => import('./routes/dashboard/v2-redirect.js'),
          },
          {
            id: 'legacy-activity',
            path: 'activity',
            component: () => import('./routes/dashboard/v2-redirect.js'),
          },
          {
            id: 'legacy-logs',
            path: 'logs',
            component: () => import('./routes/dashboard/v2-redirect.js'),
          },
          {
            id: 'legacy-nodes',
            path: 'nodes',
            component: () => import('./routes/dashboard/v2-redirect.js'),
          },
          {
            id: 'legacy-catalog',
            path: 'catalog',
            component: () => import('./routes/dashboard/v2-redirect.js'),
          },
          {
            id: 'legacy-catalog-import',
            path: 'catalog/import',
            component: () => import('./routes/dashboard/v2-redirect.js'),
          },
          {
            id: 'legacy-catalog-id',
            path: 'catalog/:id',
            component: () => import('./routes/dashboard/v2-redirect.js'),
          },
          {
            id: 'legacy-name',
            path: ':name',
            component: () => import('./routes/dashboard/v2-redirect.js'),
          },
          {
            id: 'legacy-name-releases',
            path: ':name/releases',
            component: () => import('./routes/dashboard/v2-redirect.js'),
          },
          {
            id: 'legacy-name-logs',
            path: ':name/logs',
            component: () => import('./routes/dashboard/v2-redirect.js'),
          },
          {
            id: 'legacy-name-build',
            path: ':name/build',
            component: () => import('./routes/dashboard/v2-redirect.js'),
          },
          {
            id: 'legacy-name-traffic',
            path: ':name/traffic',
            component: () => import('./routes/dashboard/v2-redirect.js'),
          },
          {
            id: 'legacy-name-settings',
            path: ':name/settings',
            component: () => import('./routes/dashboard/v2-redirect.js'),
          },
        ],
      },
      // `deploy.local/<repo>` short addresses open the repository's project. Last, so every page
      // above wins.
      {
        id: 'repository-address',
        path: ':repository',
        component: () => import('./routes/dashboard/v2-redirect.js'),
      },
      {
        id: 'repository-address-section',
        path: ':repository/:section',
        component: () => import('./routes/dashboard/v2-redirect.js'),
      },
    ],
  },
];
