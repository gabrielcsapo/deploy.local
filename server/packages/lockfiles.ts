import { parse } from 'yaml';
export function lockfileVersions(file: string, text: string, name: string): string[] {
  const versions = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v)) versions.add(v.split('(')[0]);
  };
  try {
    if (file === 'package-lock.json') {
      const doc = JSON.parse(text);
      for (const [key, value] of Object.entries(doc.packages || {}) as [string, any][])
        if (key === 'node_modules/' + name || key.endsWith('/node_modules/' + name))
          add(value.version);
      const walk = (deps: any) => {
        for (const [key, value] of Object.entries(deps || {}) as [string, any][]) {
          if (key === name) add(value.version);
          walk(value.dependencies);
        }
      };
      walk(doc.dependencies);
    } else if (file === 'pnpm-lock.yaml') {
      const doc = parse(text);
      for (const key of Object.keys(doc.packages || {})) {
        const normalized = key.replace(/^\//, '');
        if (normalized.startsWith(name + '@')) add(normalized.slice(name.length + 1));
        if (normalized.startsWith(name + '/')) add(normalized.slice(name.length + 1));
      }
    } else if (file === 'bun.lock') {
      // Bun's text lockfile is JSONC with trailing commas. Match package identities,
      // not arbitrary mentions in dependency descriptions.
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const match of text.matchAll(new RegExp('"' + escaped + '@([0-9][^"\\s]*)"', 'g')))
        add(match[1]);
    } else {
      // Both Yarn classic's quoted multi-selectors and Berry's npm: selectors.
      let selected = false;
      for (const line of text.split('\n')) {
        if (/^\S/.test(line) && line.endsWith(':'))
          selected = line
            .split(/,\s*/)
            .some((selector) => selector.replace(/^["']/, '').startsWith(name + '@'));
        if (selected) {
          const match = line.match(/^\s+version\s*:?\s+["']?([^"'\s]+)/);
          if (match) add(match[1]);
        }
      }
    }
  } catch {
    /* A malformed lockfile supplies no usage claim. */
  }
  return [...versions];
}

/** Local workspace links are resolved against their importer, never against the host filesystem. */
export function lockfileLinks(file: string, text: string, name: string): string[] {
  const links: string[] = [];
  if (file === 'pnpm-lock.yaml') {
    const doc = parse(text);
    for (const [importer, value] of Object.entries(doc.importers || {}) as [string, any][]) {
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        const version = value[section]?.[name]?.version;
        if (typeof version === 'string' && version.startsWith('link:'))
          links.push(importer + '/' + version.slice(5));
      }
    }
  } else if (file === 'package-lock.json') {
    const doc = JSON.parse(text);
    for (const [path, value] of Object.entries(doc.packages || {}) as [string, any][]) {
      if (
        (path === 'node_modules/' + name || path.endsWith('/node_modules/' + name)) &&
        value.link &&
        typeof value.resolved === 'string'
      )
        links.push(value.resolved);
    }
  }
  return links;
}
