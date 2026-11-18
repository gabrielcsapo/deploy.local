import type { RouteConfig } from 'react-flight-router/router';
import { pullRoutes } from '../tasks/routes.ts';
import { releasesRoutes } from '../releases/routes.ts';
import { workRedirect } from './routing.ts';

export const projectSectionRoutes: RouteConfig[] = [
  {
    id: 'v2-projects-p-work',
    path: 'work',
    component: () => import('./tab.js'),
  },
  { id: 'v2-projects-p-issues', path: 'issues', redirect: workRedirect, redirectStatus: 302 },
  {
    id: 'v2-projects-p-apps-app',
    path: 'apps/:app',
    component: () => import('./tab.js'),
  },
  {
    id: 'v2-projects-p-apps-app-settings',
    path: 'apps/:app/settings',
    component: () => import('./tab.js'),
  },
  {
    id: 'v2-projects-p-requests',
    path: 'requests',
    component: () => import('./tab.js'),
  },
  {
    id: 'v2-projects-p-performance',
    path: 'performance',
    component: () => import('./tab.js'),
  },
  {
    id: 'v2-projects-p-apps-app-performance',
    path: 'apps/:app/performance',
    component: () => import('./tab.js'),
  },
  {
    id: 'v2-projects-p-request',
    path: 'requests/:id',
    component: () => import('./tab.js'),
  },
  {
    id: 'v2-projects-p-apps-app-requests',
    path: 'apps/:app/requests',
    component: () => import('./tab.js'),
  },
  {
    id: 'v2-projects-p-apps-app-request',
    path: 'apps/:app/requests/:id',
    component: () => import('./tab.js'),
  },
  {
    id: 'v2-project-pipelines',
    path: 'pipelines',
    component: () => import('./tab.js'),
  },
];
export const projectLogSettingsRoutes: RouteConfig[] = [
  {
    id: 'v2-projects-p-logs',
    path: 'logs',
    component: () => import('./tab.js'),
  },
  {
    id: 'v2-projects-p-settings',
    path: 'settings',
    component: () => import('./tab.js'),
  },
];

export const projectsRoutes: RouteConfig[] = [
  { id: 'v2-projects', path: 'projects', component: () => import('./page.js') },
  {
    id: 'v2-project-layout',
    path: 'projects/:p',
    component: () => import('./layout.js'),
    children: [
      { id: 'v2-projects-p', index: true, component: () => import('./tab.js') },
      { id: 'v2-projects-p-code', path: 'code', component: () => import('./tab.js') },
      ...projectSectionRoutes,
      ...projectLogSettingsRoutes,
      ...pullRoutes,
      ...releasesRoutes,
    ],
  },
];
