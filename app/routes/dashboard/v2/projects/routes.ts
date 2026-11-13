import type { RouteConfig } from 'react-flight-router/router';
import { pullRoutes } from '../tasks/routes.ts';
import { releasesRoutes } from '../releases/routes.ts';

export const projectSectionRoutes: RouteConfig[] = [
  {
    id: 'v2-projects-p-issues',
    path: 'issues',
    component: () => import('./content.client.js'),
  },
  {
    id: 'v2-projects-p-apps-app',
    path: 'apps/:app',
    component: () => import('./content.client.js'),
  },
  {
    id: 'v2-projects-p-apps-app-settings',
    path: 'apps/:app/settings',
    component: () => import('./content.client.js'),
  },
  {
    id: 'v2-projects-p-requests',
    path: 'requests',
    component: () => import('./content.client.js'),
  },
  {
    id: 'v2-projects-p-performance',
    path: 'performance',
    component: () => import('./content.client.js'),
  },
  {
    id: 'v2-projects-p-apps-app-performance',
    path: 'apps/:app/performance',
    component: () => import('./content.client.js'),
  },
  {
    id: 'v2-projects-p-request',
    path: 'requests/:id',
    component: () => import('./content.client.js'),
  },
  {
    id: 'v2-projects-p-apps-app-requests',
    path: 'apps/:app/requests',
    component: () => import('./content.client.js'),
  },
  {
    id: 'v2-projects-p-apps-app-request',
    path: 'apps/:app/requests/:id',
    component: () => import('./content.client.js'),
  },
  {
    id: 'v2-project-pipelines',
    path: 'pipelines',
    component: () => import('./content.client.js'),
  },
];
export const projectLogSettingsRoutes: RouteConfig[] = [
  {
    id: 'v2-projects-p-logs',
    path: 'logs',
    component: () => import('./content.client.js'),
  },
  {
    id: 'v2-projects-p-settings',
    path: 'settings',
    component: () => import('./content.client.js'),
  },
];

export const projectsRoutes: RouteConfig[] = [
  { id: 'v2-projects', path: 'projects', component: () => import('./page.client.js') },
  {
    id: 'v2-project-layout',
    path: 'projects/:p',
    component: () => import('./layout.js'),
    children: [
      { id: 'v2-projects-p', index: true, component: () => import('./content.client.js') },
      { id: 'v2-projects-p-code', path: 'code', component: () => import('./content.client.js') },
      ...projectSectionRoutes,
      ...projectLogSettingsRoutes,
      ...pullRoutes,
      ...releasesRoutes,
    ],
  },
];
