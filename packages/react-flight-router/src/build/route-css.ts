import { relative, resolve } from 'path';
import type { Plugin } from 'vite';

export type ModuleGraph = Map<string, Set<string>>;

/** Capture resolved imports on both sides of the RSC/client boundary.
 * Client lazy components can stay cached after their sheet has been removed. Include
 * their CSS with their owner so revisiting it works even when import() never runs again.
 * Never follow RSC dynamic imports: those are the independently matched routes.
 */
export function routeCSSPlugin(graph: ModuleGraph, appDir: string, rsc = false): Plugin {
  return {
    name: 'react-flight-router:route-css',
    generateBundle() {
      for (const id of this.getModuleIds()) {
        const info = this.getModuleInfo(id);
        if (!info) continue;
        const imports = graph.get(id) ?? new Set<string>();
        for (const dep of info.importedIds) imports.add(dep);
        if (!rsc) for (const dep of info.dynamicallyImportedIds) imports.add(dep);
        graph.set(id, imports);
      }
    },
    // Decorate lazy module namespaces, not the route config's source syntax.
    // This also works with routes assembled in helpers and with slot/boundary loaders.
    renderChunk(code, chunk) {
      if (!rsc || !chunk.facadeModuleId) return null;
      const id = relative(appDir, chunk.facadeModuleId).replaceAll('\\', '/');
      return { code: `${code}\nexport const __flight_css_id = ${JSON.stringify(id)};`, map: null };
    },
  };
}

export interface CSSManifestEntry {
  file: string;
  css?: string[];
  imports?: string[];
}

/** Last occurrence wins: the legacy HTML could contain a sheet more than once. */
export function stylesheetOrder(files: string[]): string[] {
  return files.filter((file, index) => files.lastIndexOf(file) === index);
}

export function moduleStylesheets(
  graph: ModuleGraph,
  manifest: Record<string, CSSManifestEntry>,
  appDir: string,
  order: string[],
  roots: Iterable<string> = graph.keys(),
): Record<string, string[]> {
  const assets = new Map<string, Set<string>>();
  for (const key of Object.keys(manifest)) {
    const seen = new Set<string>();
    const css = new Set<string>();
    const visit = (key: string) => {
      if (seen.has(key)) return;
      seen.add(key);
      const item = manifest[key];
      if (!item) return;
      for (const file of item.css ?? []) css.add(`/${file}`);
      if (item.file.endsWith('.css')) css.add(`/${item.file}`);
      for (const dep of item.imports ?? []) visit(dep);
    };
    visit(key);
    assets.set(resolve(appDir, key), css);
  }
  const result: Record<string, string[]> = {};
  for (const start of roots) {
    const seen = new Set<string>();
    const needed = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const file of assets.get(id) ?? []) needed.add(file);
      for (const dep of graph.get(id) ?? []) visit(dep);
    };
    visit(start);
    result[relative(appDir, start).replaceAll('\\', '/')] = order.filter((f) => needed.has(f));
  }
  return result;
}
