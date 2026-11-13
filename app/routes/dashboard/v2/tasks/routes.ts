import type { RouteConfig } from 'react-flight-router/router';

export const tasksRoutes: RouteConfig[] = [
  {
    id: 'v2-tasks-id',
    path: 'tasks/:id',
    component: () => import('./page.client.js'),
  },
  {
    id: 'v2-tasks-id-changes',
    path: 'tasks/:id/changes',
    component: () => import('./page.client.js'),
  },
  {
    id: 'v2-tasks-id-checks',
    path: 'tasks/:id/checks',
    component: () => import('./page.client.js'),
  },
  {
    id: 'v2-tasks-id-design',
    path: 'tasks/:id/design',
    component: () => import('./page.client.js'),
  },
];
export const pullRoutes: RouteConfig[] = [
  {
    id: 'v2-projects-p-pulls',
    path: 'projects/:p/pulls',
    component: () => import('./pulls.js'),
  },
  {
    id: 'v2-projects-p-pulls-id',
    path: 'projects/:p/pulls/:id',
    component: () => import('./pulls.js'),
  },
];
