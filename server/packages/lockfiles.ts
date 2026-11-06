import { parse } from 'yaml';
export type LockfileIndex = Record<
  string,
  {
    versions: string[];
    links: string[];
    platforms?: Record<string, { os?: string[]; cpu?: string[] }>;
  }
>;
/** Parse each lockfile once, collecting all package identities and workspace links. */
export function lockfileIndex(file: string, text: string, strict = false): LockfileIndex {
  const result: LockfileIndex = Object.create(null);
  const get = (name: string) => (result[name] ||= { versions: [], links: [] });
  const add = (name: string, version: unknown, platform?: { os?: string[]; cpu?: string[] }) => {
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) return;
    const clean = version.split('(')[0];
    if (platform?.os || platform?.cpu)
      (get(name).platforms ||= {})[clean] = { os: platform.os, cpu: platform.cpu };
    if (!get(name).versions.includes(clean)) get(name).versions.push(clean);
  };
  const link = (name: string, path: string) => get(name).links.push(path);
  const identity = (key: string) => key.match(/^(@[^/]+\/[^@/]+|[^@/]+)[@/](.+)$/);
  try {
    if (file === 'package-lock.json') {
      const doc = JSON.parse(text);
      for (const [path, value] of Object.entries(doc.packages || {}) as [string, any][]) {
        const name = path.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/)?.[1];
        if (!name) continue;
        add(name, value.version, value);
        if (value.link && typeof value.resolved === 'string') link(name, value.resolved);
      }
      const walk = (deps: any) => {
        for (const [name, value] of Object.entries(deps || {}) as [string, any][]) {
          add(name, value.version, value);
          walk(value.dependencies);
        }
      };
      walk(doc.dependencies);
    } else if (file === 'pnpm-lock.yaml') {
      const doc = parse(text);
      for (const key of Object.keys(doc.packages || {})) {
        const match = identity(key.replace(/^\//, ''));
        if (match) add(match[1], match[2], doc.packages[key]);
      }
      for (const [importer, value] of Object.entries(doc.importers || {}) as [string, any][]) {
        for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
          for (const [name, dependency] of Object.entries(value[section] || {}) as [
            string,
            any,
          ][]) {
            if (typeof dependency.version === 'string' && dependency.version.startsWith('link:'))
              link(name, importer + '/' + dependency.version.slice(5));
          }
        }
      }
    } else if (file === 'bun.lock') {
      for (const match of text.matchAll(/"((?:@[^/"\s]+\/)?[^@"\s]+)@([0-9][^"\s]*)"/g))
        add(match[1], match[2]);
    } else {
      let names: string[] = [];
      for (const line of text.split('\n')) {
        if (/^\S/.test(line) && line.endsWith(':'))
          names = line.split(/,\s*/).flatMap((selector) => {
            const match = identity(selector.replace(/^["']/, ''));
            return match ? [match[1]] : [];
          });
        const match = line.match(/^\s+version\s*:?\s+["']?([^"'\s]+)/);
        if (match) for (const name of names) add(name, match[1]);
      }
    }
    return result;
  } catch (error) {
    if (strict) throw error;
    return Object.create(null);
  }
}
export function lockfileVersions(file: string, text: string, name: string): string[] {
  return lockfileIndex(file, text)[name]?.versions || [];
}
export function lockfileLinks(file: string, text: string, name: string): string[] {
  return lockfileIndex(file, text)[name]?.links || [];
}
