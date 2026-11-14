import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
// Vite already pins the ESM lexer. Parse erased JavaScript so comments, strings, import
// types and individual `type` specifiers cannot become runtime dependencies.
const require = createRequire(import.meta.url);
const { init, parse } = createRequire(require.resolve('vite'))('es-module-lexer') as {
  init: Promise<void>;
  parse: (source: string) => [{ n?: string; d: number }[]];
};
await init;

export function imports(source: string, file = 'source.ts') {
  const javascript = /\.[cm]?tsx?$/.test(file) ? stripTypeScriptTypes(source) : source;
  return parse(javascript)[0]
    .filter((entry) => entry.n !== undefined)
    .map((entry) => ({ specifier: entry.n!, dynamic: entry.d >= 0 }));
}

export function target(file: string, specifier: string) {
  if (!specifier.startsWith('.')) return undefined;
  const path = resolve(root, dirname(file), specifier);
  return [
    path,
    ...['.ts', '.tsx', '.js', '.mjs', '.cjs', '/index.ts', '/index.js'].map((s) => path + s),
  ].find((candidate) => existsSync(candidate) && !candidate.endsWith('.json'));
}

export function productionFiles(directory = join(root, 'server')): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory())
        return /^(?:fixtures?|__tests__)$/.test(entry.name) ? [] : productionFiles(path);
      return /\.[cm]?[jt]sx?$/.test(path) &&
        !/(?:\.test\.|\.d\.[cm]?ts$|(?:^|\/)test[-.]|fixture)/.test(path)
        ? [relative(root, path)]
        : [];
    })
    .sort();
}

export function runtimeGraph() {
  const files = productionFiles();
  const included = new Set(files);
  return new Map(
    files.map((file) => [
      file,
      imports(readFileSync(join(root, file), 'utf8'), file)
        .map(({ specifier }) => target(file, specifier))
        .filter((path): path is string => path !== undefined)
        .map((path) => relative(root, path))
        .filter((path) => included.has(path)),
    ]),
  );
}

export function components(graph: Map<string, string[]>) {
  let next = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const active = new Set<string>();
  const result: string[][] = [];
  function visit(file: string) {
    indices.set(file, next);
    low.set(file, next++);
    stack.push(file);
    active.add(file);
    for (const dependency of graph.get(file) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency);
        low.set(file, Math.min(low.get(file)!, low.get(dependency)!));
      } else if (active.has(dependency))
        low.set(file, Math.min(low.get(file)!, indices.get(dependency)!));
    }
    if (low.get(file) !== indices.get(file)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      active.delete(member);
      component.push(member);
    } while (member !== file);
    if (component.length > 1) result.push(component.sort());
  }
  for (const file of graph.keys()) if (!indices.has(file)) visit(file);
  return result.sort((a, b) => a[0].localeCompare(b[0]));
}
