import {
  homeRoutes,
  startRoutes,
  discoverRoutes,
  blueprintRoutes,
} from './routes/dashboard/v2/start/routes.ts';
import { designRoutes } from './routes/dashboard/v2/design/routes.ts';
import { artifactsRoutes } from './routes/dashboard/v2/artifacts/routes.ts';
import { inboxRoutes } from './routes/dashboard/v2/inbox/routes.ts';
import { liveRoutes } from './routes/dashboard/v2/live/routes.ts';
import { tasksRoutes } from './routes/dashboard/v2/tasks/routes.ts';
import { projectsRoutes } from './routes/dashboard/v2/projects/routes.ts';
import { computersRoutes } from './routes/dashboard/v2/computers/routes.ts';
import { agentsRoutes } from './routes/dashboard/v2/agents/routes.ts';
import { settingsRoutes } from './routes/dashboard/v2/settings/routes.ts';
import { packagesRoutes } from './routes/dashboard/v2/packages/routes.ts';
import type { RouteConfig } from 'react-flight-router/router';
import { declaredRedirect } from './routes/dashboard/v2-redirects.ts';

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
        redirect: declaredRedirect,
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
            redirect: declaredRedirect,
          },
          {
            id: 'docs-ship',
            path: 'ship',
            component: () => import('./routes/docs/ship.js'),
          },
          {
            id: 'docs-configuration',
            path: 'configuration',
            redirect: declaredRedirect,
          },
          {
            id: 'docs-deploy-yaml',
            path: 'deploy-yaml',
            component: () => import('./routes/docs/deploy-yaml.js'),
          },
          {
            id: 'docs-managing',
            path: 'managing',
            redirect: declaredRedirect,
          },
          {
            id: 'docs-live',
            path: 'live',
            component: () => import('./routes/docs/live.js'),
          },
          {
            id: 'docs-nodes',
            path: 'nodes',
            redirect: declaredRedirect,
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
            redirect: declaredRedirect,
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
        id: 'npm-login',
        path: 'packages/npm-login/:id',
        component: () => import('./routes/npm-login/page.js'),
      },
      {
        id: 'packages-short',
        path: 'packages',
        redirect: declaredRedirect,
      },
      {
        id: 'package-short',
        path: 'packages/npm/:name',
        redirect: declaredRedirect,
      },
      {
        id: 'package-short-scoped',
        path: 'packages/npm/:scope/:name',
        redirect: declaredRedirect,
      },
      // The workspace: `/dashboard/...` and repository short addresses share one layout, so moving
      // between tasks and a repository keeps it mounted. Last, so every page above wins.
      {
        id: 'dashboard',
        path: 'dashboard',
        component: () => import('./routes/dashboard/v2/start/layout.js'),
        children: [
          ...homeRoutes,
          {
            id: 'dashboard-design-system',
            path: 'design-system',
            component: () => import('./routes/dashboard/design-system.js'),
          },
          ...designRoutes,
          ...artifactsRoutes,
          ...inboxRoutes,
          ...liveRoutes,
          ...tasksRoutes,
          ...projectsRoutes,
          ...computersRoutes,
          ...agentsRoutes,
          ...startRoutes,
          ...packagesRoutes,
          ...settingsRoutes,
          ...discoverRoutes,
          {
            id: 'v2-discover-import',
            path: 'discover/import',
            component: () => import('./routes/dashboard/v2-placeholder.js'),
          },
          ...blueprintRoutes,
          {
            id: 'legacy-repositories',
            path: 'repositories',
            redirect: declaredRedirect,
          },
          {
            id: 'legacy-repository',
            path: 'repositories/:projectId',
            redirect: declaredRedirect,
          },
          {
            id: 'legacy-repository-section',
            path: 'repositories/:projectId/:section',
            redirect: declaredRedirect,
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
            redirect: declaredRedirect,
          },
          {
            id: 'legacy-activity',
            path: 'activity',
            redirect: declaredRedirect,
          },
          {
            id: 'legacy-logs',
            path: 'logs',
            redirect: declaredRedirect,
          },
          {
            id: 'legacy-nodes',
            path: 'nodes',
            redirect: declaredRedirect,
          },
          {
            id: 'legacy-catalog',
            path: 'catalog',
            redirect: declaredRedirect,
          },
          {
            id: 'legacy-catalog-import',
            path: 'catalog/import',
            redirect: declaredRedirect,
          },
          {
            id: 'legacy-catalog-id',
            path: 'catalog/:id',
            redirect: declaredRedirect,
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
        redirect: declaredRedirect,
      },
      {
        id: 'repository-address-section',
        path: ':repository/:section',
        redirect: declaredRedirect,
      },
    ],
  },
];
