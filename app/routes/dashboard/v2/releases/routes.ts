import type { RouteConfig } from 'react-flight-router/router';

export const releasesRoutes: RouteConfig[] = [
  {
    id: 'v2-projects-p-releases',
    path: 'projects/:p/releases',
    component: () => import('./page.client.js'),
  },
  {
    id: 'v2-projects-p-releases-id',
    path: 'projects/:p/releases/:id',
    component: () => import('./page.client.js'),
  },
];
