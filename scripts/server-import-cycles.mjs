// Static relative imports/re-exports, excluding explicit type-only declarations and tests.
// Reports strongly connected components (each contains at least one import cycle).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
const root = resolve('server');
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = resolve(dir, e.name);
    return e.isDirectory()
      ? files(p)
      : /\.(?:ts|mjs|js)$/.test(p) && !/\.(?:test|d)\.ts$/.test(p)
        ? [p]
        : [];
  });
}
const graph = new Map(
  files(root).map((path) => {
    const source = readFileSync(path, 'utf8');
    const imports = [
      ...source.matchAll(
        /^\s*(?:import|export)\s+(?!type\b)(?:(?:[\w*$]+\s*,?\s*)?(?:\{[^}]*\}|\*\s+as\s+\w+)\s*from\s*|[\w$]+\s+from\s*)?['"]([^'"]+)['"]/gm,
      ),
    ];
    return [
      path,
      imports.flatMap(([declaration, specifier]) => {
        if (
          !specifier.startsWith('.') ||
          (/^\s*(?:import|export)\s*\{\s*type\b[^}]*\}/.test(declaration) &&
            !/,\s*(?!type\b)[\w$]/.test(declaration))
        )
          return [];
        const target = resolve(dirname(path), specifier);
        const found = [target, target + '.ts', resolve(target, 'index.ts')].find(existsSync);
        return found ? [found] : [];
      }),
    ];
  }),
);
let next = 0;
const indices = new Map(),
  low = new Map(),
  stack = [],
  active = new Set(),
  cycles = [];
function visit(path) {
  indices.set(path, next);
  low.set(path, next++);
  stack.push(path);
  active.add(path);
  for (const dep of graph.get(path) ?? []) {
    if (!graph.has(dep)) continue;
    if (!indices.has(dep)) {
      visit(dep);
      low.set(path, Math.min(low.get(path), low.get(dep)));
    } else if (active.has(dep)) low.set(path, Math.min(low.get(path), indices.get(dep)));
  }
  if (low.get(path) === indices.get(path)) {
    const component = [];
    let member;
    do {
      member = stack.pop();
      active.delete(member);
      component.push(member);
    } while (member !== path);
    if (component.length > 1 || graph.get(path)?.includes(path)) cycles.push(component.sort());
  }
}
for (const path of graph.keys()) if (!indices.has(path)) visit(path);
console.log(
  JSON.stringify(
    {
      files: graph.size,
      components: cycles.map((component) => component.map((p) => relative(process.cwd(), p))),
    },
    null,
    2,
  ),
);
