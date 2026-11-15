import type { RouteConfig } from 'react-flight-router/router';

/** Artifacts: the gallery of every project's designs and documents, and a document's page. */
export const artifactsRoutes: RouteConfig[] = [
  {
    id: 'v2-artifacts',
    path: 'artifacts',
    component: () => import('./page.js'),
  },
  {
    id: 'v2-artifact',
    path: 'artifacts/:project/:artifact',
    component: () => import('./page.js'),
  },
];
