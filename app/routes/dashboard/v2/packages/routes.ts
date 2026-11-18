import type { RouteConfig } from 'react-flight-router/router';

/** Packages' pages, under `/dashboard`. The page is a client module the router renders directly. */
export const packagesRoutes: RouteConfig[] = [
  { id: 'v2-packages-kept', path: 'packages/kept', component: () => import('./page.js') },
  {
    id: 'v2-package-kept',
    path: 'packages/kept/:ecosystem/:name',
    component: () => import('./page.js'),
  },
  {
    id: 'v2-package-kept-scoped',
    path: 'packages/kept/:ecosystem/:scope/:name',
    component: () => import('./page.js'),
  },
  {
    id: 'v2-packages',
    path: 'packages',
    component: () => import('./page.js'),
  },
  {
    id: 'v2-package',
    path: 'packages/npm/:name',
    component: () => import('./page.js'),
  },
  {
    id: 'v2-scoped-package',
    path: 'packages/npm/:scope/:name',
    component: () => import('./page.js'),
  },
];
