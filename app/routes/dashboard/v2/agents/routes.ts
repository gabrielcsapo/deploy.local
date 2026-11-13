import type { RouteConfig } from 'react-flight-router/router';

export const agentsRoutes: RouteConfig[] = [
  {
    id: 'v2-agents-new',
    path: 'agents/new',
    component: () => import('./page.js'),
  },
  {
    id: 'v2-agents',
    path: 'agents',
    component: () => import('./page.js'),
  },
  {
    id: 'v2-agents-agent',
    path: 'agents/:agent',
    component: () => import('./page.js'),
  },
  {
    id: 'v2-agents-item-history',
    path: 'agents/:agent/items/:item/history',
    component: () => import('./page.js'),
  },
  {
    id: 'v2-agents-agent-tune',
    path: 'agents/:agent/tune',
    component: () => import('./page.js'),
  },
];
