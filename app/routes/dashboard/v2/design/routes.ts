import type { RouteConfig } from 'react-flight-router/router';

export const designRoutes: RouteConfig[] = [
  {
    id: 'v2-design',
    path: 'design',
    component: () => import('./page.js'),
  },
];
