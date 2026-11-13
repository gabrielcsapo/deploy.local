import type { RouteConfig } from 'react-flight-router/router';

export const projectsRoutes: RouteConfig[] = [
  {
    id: 'v2-projects',
    path: 'projects',
    component: () => import('./page.client.js'),
  },
  {
    id: 'v2-projects-p',
    path: 'projects/:p',
    component: () => import('./page.client.js'),
  },
  {
    id: 'v2-projects-p-code',
    path: 'projects/:p/code',
    component: () => import('./page.client.js'),
  },
];
export const projectSectionRoutes: RouteConfig[] = [
  {
    id: 'v2-projects-p-issues',
    path: 'projects/:p/issues',
    component: () => import('./page.client.js'),
  },
  {
    id: 'v2-projects-p-apps-app',
    path: 'projects/:p/apps/:app',
    component: () => import('./page.client.js'),
  },
  {
    id: 'v2-projects-p-apps-app-settings',
    path: 'projects/:p/apps/:app/settings',
    component: () => import('./page.client.js'),
  },
  {
    id: 'v2-projects-p-requests',
    path: 'projects/:p/requests',
    component: () => import('./page.client.js'),
  },
  {
    id: 'v2-projects-p-performance',
    path: 'projects/:p/performance',
    component: () => import('./page.client.js'),
  },
  {
    id: 'v2-projects-p-apps-app-performance',
    path: 'projects/:p/apps/:app/performance',
    component: () => import('./page.client.js'),
  },
  {
    id: 'v2-projects-p-request',
    path: 'projects/:p/requests/:id',
    component: () => import('./page.client.js'),
  },
  {
    id: 'v2-projects-p-apps-app-requests',
    path: 'projects/:p/apps/:app/requests',
    component: () => import('./page.client.js'),
  },
  {
    id: 'v2-projects-p-apps-app-request',
    path: 'projects/:p/apps/:app/requests/:id',
    component: () => import('./page.client.js'),
  },
  {
    id: 'v2-project-pipelines',
    path: 'projects/:p/pipelines',
    component: () => import('./page.client.js'),
  },
];
export const projectLogSettingsRoutes: RouteConfig[] = [
  {
    id: 'v2-projects-p-logs',
    path: 'projects/:p/logs',
    component: () => import('./page.client.js'),
  },
  {
    id: 'v2-projects-p-settings',
    path: 'projects/:p/settings',
    component: () => import('./page.client.js'),
  },
];
