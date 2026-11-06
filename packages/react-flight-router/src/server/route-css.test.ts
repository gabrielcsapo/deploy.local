import { expect, it } from 'vitest';
import { renderRSC } from './rsc-renderer.js';
import { routeStylesheets } from './route-css.js';
import type { RouteConfig, RouteMatch } from '../router/types.js';

const load = (id: string) => async () => ({ default: () => null, __flight_css_id: id });
const manifests = {
  cssFiles: [
    '/entry.css',
    '/b.css',
    '/root.css',
    '/error.css',
    '/a.css',
    '/missing.css',
    '/slot.css',
  ],
  entryCSS: ['/entry.css'],
  cssModules: {
    root: ['/root.css'],
    a: ['/a.css'],
    b: ['/b.css'],
    error: ['/error.css'],
    missing: ['/missing.css'],
    slot: ['/slot.css'],
  },
};
const routes: RouteConfig[] = [
  {
    id: 'root',
    path: '',
    component: load('root'),
    error: load('error'),
    notFound: load('missing'),
    slots: { modal: [{ id: 'slot', path: 'show', component: load('slot') }] },
    children: [
      { id: 'a', path: 'a', component: load('a') },
      { id: 'b', path: 'b', component: load('b') },
    ],
  },
];
async function payload(path: string, previous?: string, config = routes) {
  let result: any;
  const rendered = await renderRSC({
    routes: config,
    url: new URL(path, 'http://test'),
    previousUrl: previous ? new URL(previous, 'http://test') : undefined,
    stylesheets: manifests,
    clientManifest: {},
    loadModule: async () => ({}),
    renderToReadableStream: (model) => {
      result = model;
      return new ReadableStream({
        start(c) {
          c.close();
        },
      });
    },
  });
  return { ...result, status: rendered.status };
}
it('sends the same complete ordered CSS on fresh, partial, and slot navigations', async () => {
  const fresh = await payload('/a');
  expect(fresh.cssFiles).toEqual([
    '/entry.css',
    '/root.css',
    '/error.css',
    '/a.css',
    '/missing.css',
  ]);
  expect((await payload('/a', '/b')).cssFiles).toEqual(fresh.cssFiles);
  expect((await payload('/a?@modal=show', '/a')).cssFiles).toEqual([
    ...fresh.cssFiles,
    '/slot.css',
  ]);
  expect((await payload('/a', '/a?@modal=show')).cssFiles).toEqual(fresh.cssFiles);
  expect((await payload('/b')).cssFiles).not.toContain('/a.css');
});
it('includes not-found and ancestor error styles when a module fails', async () => {
  expect((await payload('/unknown')).cssFiles).toContain('/missing.css');
  const broken: RouteConfig[] = [
    {
      ...routes[0],
      children: [
        {
          id: 'broken',
          path: 'broken',
          component: async () => {
            throw new Error('broken');
          },
        },
      ],
    },
  ];
  const error = await payload('/broken', undefined, broken);
  expect(error.status).toBe(500);
  expect(error.cssFiles).toContain('/error.css');
});
it('supports legacy manifests and custom loaders without build metadata', async () => {
  expect(await routeStylesheets([], { cssFiles: ['/legacy.css'] })).toEqual(['/legacy.css']);
  const matches = [
    {
      params: {},
      pathname: '/',
      segmentKey: 'inline',
      route: { id: 'inline', component: async () => ({ default: () => null }) },
    },
  ] as RouteMatch[];
  expect(await routeStylesheets(matches, manifests)).toEqual(manifests.cssFiles);
});

it('imports each route once per request while keeping custom loaders request-local', async () => {
  let calls = 0;
  const config: RouteConfig[] = [
    {
      id: 'root',
      path: '',
      component: async () => {
        calls++;
        return { default: () => null, __flight_css_id: 'root' };
      },
    },
  ];
  await payload('/', undefined, config);
  expect(calls).toBe(1);
  await payload('/', undefined, config);
  expect(calls).toBe(2);
});
