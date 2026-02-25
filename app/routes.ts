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
            id: 'docs-cli',
            path: 'cli',
            component: () => import('./routes/docs/cli.js'),
          },
          {
            id: 'docs-architecture',
            path: 'architecture',
            component: () => import('./routes/docs/architecture.js'),
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
            id: 'dashboard-settings',
            path: 'settings',
            component: () => import('./routes/dashboard/settings.js'),
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
                component: () => import('./routes/dashboard/detail/build.js'),
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
                component: () => import('./routes/dashboard/detail/requests.js'),
              },
              {
                id: 'dashboard-detail-resources',
                path: 'resources',
                component: () => import('./routes/dashboard/detail/resources.js'),
              },
              {
                id: 'dashboard-detail-history',
                path: 'history',
                component: () => import('./routes/dashboard/detail/history.js'),
              },
              {
                id: 'dashboard-detail-backups',
                path: 'backups',
                component: () => import('./routes/dashboard/detail/backups.js'),
              },
            ],
          },
        ],
      },
    ],
  },
];
