import type * as pages from './v2/project-page.ts';

/**
 * Server-rendered pages read through the running server, never through their own copy of it.
 * The page bundle is built separately from the server: importing server modules there gives the
 * page a second instance of every store, cache and probe, whose in-memory state the real
 * server never updates. boot.ts registers the server's own readers here instead.
 */
export type PageLoader = Pick<
  typeof pages,
  | 'projectPageOwner'
  | 'projectPageURL'
  | 'dashboardPageURL'
  | 'loadProjectPage'
  | 'loadDashboardPage'
  | 'loadProjectTab'
>;
const KEY = Symbol.for('deploy.local/page-loader');
type Registry = { [KEY]?: PageLoader };

export function registerPageLoader(loader: PageLoader) {
  (globalThis as Registry)[KEY] = loader;
}

/** Without a running server (a test, a build step) pages render the browser-loaded path. */
const none: PageLoader = {
  projectPageOwner: () => undefined,
  projectPageURL: () => undefined,
  dashboardPageURL: () => undefined,
  loadProjectPage: async () => undefined,
  loadDashboardPage: async () => undefined,
  loadProjectTab: async () => undefined,
};
export const pageLoader = (): PageLoader => (globalThis as Registry)[KEY] ?? none;
