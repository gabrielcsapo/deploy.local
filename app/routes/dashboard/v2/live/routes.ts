import type { RouteConfig } from 'react-flight-router/router';

export const liveRoutes: RouteConfig[] = [
  {
    id: 'v2-live',
    path: 'live',
    component: () => import('./page.js'),
  },
  {
    id: 'v2-live-app',
    path: 'live/:app',
    component: () => import('./page.js'),
  },
];
