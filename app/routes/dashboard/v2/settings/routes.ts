import type { RouteConfig } from 'react-flight-router/router';

export const settingsRoutes: RouteConfig[] = [
  {
    id: 'v2-settings',
    path: 'settings',
    component: () => import('./page.client.js'),
  },
  {
    id: 'v2-settings-approvals',
    path: 'settings/approvals',
    component: () => import('./page.client.js'),
  },
  {
    id: 'v2-settings-backups',
    path: 'settings/backups',
    component: () => import('./backups/page.client.js'),
  },
];
