import type { RouteConfig } from 'react-flight-router/router';

export const inboxRoutes: RouteConfig[] = [
  {
    id: 'v2-inbox',
    path: 'inbox',
    component: () => import('./page.js'),
  },
];
