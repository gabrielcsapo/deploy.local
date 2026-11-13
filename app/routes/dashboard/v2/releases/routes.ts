import type { RouteConfig } from 'react-flight-router/router';

export const releasesRoutes: RouteConfig[] = [
  {
    id: 'v2-projects-p-releases',
    path: 'releases',
    component: () => import('./page.js'),
  },
  {
    id: 'v2-projects-p-releases-id',
    path: 'releases/:id',
    component: () => import('./page.js'),
  },
];
