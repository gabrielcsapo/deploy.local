import type { RouteConfig } from 'react-flight-router/router';

export const computersRoutes: RouteConfig[] = [
  {
    id: 'v2-computers',
    path: 'computers',
    component: () => import('./page.js'),
  },
  {
    id: 'v2-computers-models',
    path: 'computers/models',
    component: () => import('./page.js'),
  },
  {
    id: 'v2-computers-add',
    path: 'computers/add',
    component: () => import('./page.js'),
  },
  {
    id: 'v2-computers-id',
    path: 'computers/:id',
    component: () => import('./page.js'),
  },
];
