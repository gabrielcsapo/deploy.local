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
        component: () => import('./routes/home.js'),
      },
      {
        id: 'discover',
        path: 'discover',
        component: () => import('./routes/discover.js'),
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
            id: 'docs-deploying',
            path: 'deploying',
            component: () => import('./routes/docs/deploying.js'),
          },
          {
            id: 'docs-configuration',
            path: 'configuration',
            component: () => import('./routes/docs/configuration.js'),
          },
          {
            id: 'docs-managing',
            path: 'managing',
            component: () => import('./routes/docs/managing.js'),
          },
          {
            id: 'docs-nodes',
            path: 'nodes',
            component: () => import('./routes/docs/nodes.js'),
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
            component: () => import('./routes/docs/roadmap.js'),
          },
          {
            id: 'docs-troubleshooting',
            path: 'troubleshooting',
            component: () => import('./routes/docs/troubleshooting.js'),
          },
        ],
      },
      {
        id: 'dashboard',
        path: 'dashboard',
        component: () => import('./routes/dashboard/layout.js'),
        children: [
          {
            id: 'dashboard-index',
            index: true,
            component: () => import('./routes/dashboard/index.js'),
          },
          {
            id: 'dashboard-apps',
            path: 'apps',
            component: () => import('./routes/dashboard/apps.js'),
          },
          {
            id: 'dashboard-activity',
            path: 'activity',
            component: () => import('./routes/dashboard/activity.js'),
          },
          {
            id: 'dashboard-logs',
            path: 'logs',
            component: () => import('./routes/dashboard/logs.js'),
          },
          {
            id: 'dashboard-discover',
            path: 'discover',
            component: () => import('./routes/dashboard/discover.js'),
          },
          {
            id: 'dashboard-settings',
            path: 'settings',
            component: () => import('./routes/dashboard/settings.js'),
          },
          {
            id: 'dashboard-nodes',
            path: 'nodes',
            component: () => import('./routes/dashboard/nodes.js'),
          },
          {
            id: 'dashboard-sites',
            path: 'sites',
            component: () => import('./routes/dashboard/sites.js'),
          },
          {
            id: 'dashboard-catalog',
            path: 'catalog',
            component: () => import('./routes/dashboard/catalog/index.js'),
          },
          {
            id: 'dashboard-catalog-import',
            path: 'catalog/import',
            component: () => import('./routes/dashboard/catalog/import.js'),
          },
          {
            id: 'dashboard-catalog-detail',
            path: 'catalog/:blueprintId/:release',
            component: () => import('./routes/dashboard/catalog/detail.js'),
          },
          {
            id: 'dashboard-detail',
            path: ':name',
            component: () => import('./routes/dashboard/detail/layout.js'),
            children: [
              {
                id: 'dashboard-detail-overview',
                index: true,
                component: () => import('./routes/dashboard/detail/overview.js'),
              },
              {
                id: 'dashboard-detail-build',
                path: 'build',
                component: () => import('./routes/dashboard/detail/releases.js'),
              },
              {
                id: 'dashboard-detail-releases',
                path: 'releases',
                component: () => import('./routes/dashboard/detail/releases.js'),
              },
              {
                id: 'dashboard-detail-logs',
                path: 'logs',
                component: () => import('./routes/dashboard/detail/logs.js'),
              },
              {
                id: 'dashboard-detail-terminal',
                path: 'terminal',
                component: () => import('./routes/dashboard/detail/terminal.js'),
              },
              {
                id: 'dashboard-detail-requests',
                path: 'requests',
                component: () => import('./routes/dashboard/detail/traffic.js'),
              },
              {
                id: 'dashboard-detail-traffic',
                path: 'traffic',
                component: () => import('./routes/dashboard/detail/traffic.js'),
              },
              {
                id: 'dashboard-detail-resources',
                path: 'resources',
                component: () => import('./routes/dashboard/detail/data.js'),
              },
              {
                id: 'dashboard-detail-data',
                path: 'data',
                component: () => import('./routes/dashboard/detail/data.js'),
              },
              {
                id: 'dashboard-detail-history',
                path: 'history',
                component: () => import('./routes/dashboard/detail/activity.js'),
              },
              {
                id: 'dashboard-detail-activity',
                path: 'activity',
                component: () => import('./routes/dashboard/detail/activity.js'),
              },
              {
                id: 'dashboard-detail-settings',
                path: 'settings',
                component: () => import('./routes/dashboard/detail/settings.js'),
              },
            ],
          },
        ],
      },
    ],
  },
];
