// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRoutes, resolveRouteClientModules } from './build-format.js';

describe('parseRoutes', () => {
  it('reads routes composed from a feature file and keeps redirects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flight-parse-routes-'));
    try {
      mkdirSync(join(root, 'routes/packages'), { recursive: true });
      writeFileSync(
        join(root, 'routes.ts'),
        `import type { RouteConfig } from 'react-flight-router/router';
import { packagesRoutes } from './routes/packages/routes.ts';
import { destination } from './redirects';
export const routes: RouteConfig[] = [
  { id: 'root', path: '', component: () => import('./root.js'), children: [
    { id: 'old', path: 'old', redirect: ({ url }) => destination(url) },
    ...packagesRoutes,
  ] },
];
`,
      );
      writeFileSync(
        join(root, 'redirects.ts'),
        `export const destination = (url: URL) => '/new';\n`,
      );
      writeFileSync(
        join(root, 'routes/packages/routes.ts'),
        `import type { RouteConfig } from 'react-flight-router/router';
export const packagesRoutes: RouteConfig[] = [
  { id: 'packages', path: 'packages', component: () => import('./page.client.js') },
];
`,
      );
      writeFileSync(join(root, 'root.tsx'), 'export default () => null;\n');
      writeFileSync(
        join(root, 'routes/packages/page.client.tsx'),
        "'use client';\nexport default () => null;\n",
      );

      const routes = await parseRoutes(join(root, 'routes.ts'));
      expect(routes).toHaveLength(1);
      const [old, packages] = routes[0].children!;
      expect(old).toMatchObject({ id: 'old', path: 'old' });
      expect(packages).toEqual({
        id: 'packages',
        path: 'packages',
        componentPath: join(root, 'routes/packages/page.client.js'),
      });
      const client = join(root, 'routes/packages/page.client.tsx');
      const modules = resolveRouteClientModules(routes, root, new Set([client]));
      expect([...modules.get('packages')!]).toEqual([client]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns an empty list for a file it cannot evaluate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flight-parse-routes-'));
    try {
      writeFileSync(join(root, 'routes.ts'), 'export const routes = [ ...missing ];\n');
      expect(await parseRoutes(join(root, 'routes.ts'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
