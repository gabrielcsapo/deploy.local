import type { RouteConfig } from 'flight-router/router';

export const routes: RouteConfig[] = [
  {
    id: 'root',
    path: '',
    component: () => import('./root.js'),
    children: [
      {
        id: 'home',
        index: true,
        component: () => import('./routes/home.js'),
      },
      {
        id: 'about',
        path: 'about',
        component: () => import('./routes/about.js'),
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
        ],
      },
    ],
  },
];
