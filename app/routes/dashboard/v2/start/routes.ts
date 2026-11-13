import type { RouteConfig } from 'react-flight-router/router';

export const homeRoutes: RouteConfig[] = [
  {
    id: 'dashboard-index',
    index: true,
    component: () => import('./home.js'),
  },
];
export const startRoutes: RouteConfig[] = [
  {
    id: 'v2-start',
    path: 'start',
    component: () => import('./page.js'),
  },
  {
    id: 'v2-start-project',
    path: 'start/project',
    component: () => import('./page.js'),
  },
  {
    id: 'v2-start-apps',
    path: 'start/apps',
    component: () => import('./page.js'),
  },
  {
    id: 'v2-settings-account',
    path: 'settings/account',
    component: () => import('./account.js'),
  },
  {
    id: 'v2-devices',
    path: 'settings/devices',
    component: () => import('./account.js'),
  },
];
export const discoverRoutes: RouteConfig[] = [
  {
    id: 'v2-discover',
    path: 'discover',
    component: () => import('./page.js'),
  },
];
export const blueprintRoutes: RouteConfig[] = [
  {
    id: 'v2-discover-blueprint',
    path: 'discover/:blueprint',
    component: () => import('./page.js'),
  },
];
