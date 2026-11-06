import type { RouteMatch, RouteModule } from '../router/types.js';
import type { Manifests } from '../shared/types.js';

export type RouteModuleLoader = (importer: () => Promise<RouteModule>) => Promise<RouteModule>;

/** Full matched chain, even on a partial Flight response. Boundaries can render locally. */
export async function routeStylesheets(
  matches: RouteMatch[],
  manifests: Pick<Manifests, 'cssFiles' | 'cssModules' | 'entryCSS'>,
  loadRouteModule: RouteModuleLoader = (load) => load(),
): Promise<string[]> {
  if (!manifests.cssModules) return manifests.cssFiles; // builds made by older routers
  const needed = new Set(manifests.entryCSS);
  let unknownModule = false;
  const loaders = new Set(
    matches.flatMap(({ route }) =>
      [route.component, route.loading, route.error, route.notFound].filter((f) => !!f),
    ),
  );
  await Promise.all(
    [...loaders].map(async (load) => {
      try {
        const mod = await loadRouteModule(load);
        if (!mod.__flight_css_id || !(mod.__flight_css_id in manifests.cssModules!)) {
          unknownModule = true; // inline/custom loaders without build metadata keep legacy CSS
        } else {
          for (const file of manifests.cssModules![mod.__flight_css_id]) needed.add(file);
        }
      } catch {
        // Rendering owns error handling. Ancestor error styles are already included.
      }
    }),
  );
  if (unknownModule) return manifests.cssFiles;
  return manifests.cssFiles.filter((file) => needed.has(file));
}
