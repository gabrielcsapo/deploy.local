import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { lockfileIndex } from '../../packages/lockfiles.ts';
import { type Dependency, type Entry, type Lock, type Locked, type Manifest } from './model.ts';

export const lockNames = new Set([
  'Cargo.lock',
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
]);
const npmSections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const cargoSections = ['dependencies', 'dev-dependencies', 'build-dependencies'];
const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
const pairs = (value: unknown): [string, any][] =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [];
const objectWith = (value: unknown, key: string) =>
  pairs(value).find(([name]) => name === key)?.[1];

function npmDependency(alias: string, value: string): Dependency {
  const target = value.match(/^npm:((?:@[^/]+\/)?[^@]+)(?:@.*)?$/)?.[1];
  return { alias, name: target ?? alias, requirement: value };
}

export function npmManifest(text: string): Manifest {
  const doc = JSON.parse(text);
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc))
    throw new Error('Expected a package object');
  const entries: Entry[] = [];
  const addEntry = (name: string, path: unknown, exposure: Entry['exposure'] = 'import') => {
    if (
      typeof path === 'string' &&
      !entries.some((entry) => entry.name === name && entry.path === path)
    )
      entries.push({ name, path, exposure });
  };
  const targets = (name: string, value: unknown, depth = 0) => {
    if (depth > 32) return;
    if (Array.isArray(value)) for (const target of value) targets(name, target, depth + 1);
    else if (typeof value === 'string') addEntry(name, value);
    else for (const [, target] of pairs(value)) targets(name, target, depth + 1);
  };
  if (pairs(doc.exports).some(([key]) => key.startsWith('.'))) {
    for (const [key, value] of pairs(doc.exports)) targets(key, value);
  } else targets('.', doc.exports);
  if (!Object.hasOwn(doc, 'exports')) {
    for (const path of [doc.types, doc.typings, doc.module, doc.main, 'index']) addEntry('.', path);
  }
  // Keep main as an entry point even when the exports map controls import resolution.
  if (
    typeof doc.main === 'string' &&
    Object.hasOwn(doc, 'exports') &&
    !entries.some((entry) => entry.path === doc.main)
  )
    entries.push({ name: 'main', path: doc.main, exposure: 'entry' });
  const name = str(doc.name);
  if (typeof doc.bin === 'string') addEntry(name?.split('/').at(-1) ?? 'bin', doc.bin, 'bin');
  for (const [bin, path] of pairs(doc.bin)) addEntry(bin, path, 'bin');
  const dependencies = new Map<string, Dependency>();
  for (const section of npmSections)
    for (const [alias, value] of pairs(doc[section]))
      if (typeof value === 'string') dependencies.set(alias, npmDependency(alias, value));
  return {
    ecosystem: 'npm',
    name,
    version: str(doc.version),
    description: str(doc.description),
    private: doc.private === true,
    entries,
    dependencies: [...dependencies.values()],
    wildcardEntries: !Object.hasOwn(doc, 'exports'),
  };
}

export function cargoManifest(text: string): Manifest {
  const doc: any = parseToml(text);
  const pkg = doc.package ?? {};
  const name = str(pkg.name);
  const entries: Entry[] = [];
  if (name) {
    entries.push({ name: '.', path: str(doc.lib?.path) ?? 'src/lib.rs', exposure: 'import' });
    if (!Array.isArray(doc.bin) || !doc.bin.some((bin: any) => bin.name === name))
      if (pkg.autobins !== false) entries.push({ name, path: 'src/main.rs', exposure: 'bin' });
  }
  for (const bin of Array.isArray(doc.bin) ? doc.bin : [])
    if (typeof bin.name === 'string')
      entries.push({
        name: bin.name,
        path: str(bin.path) ?? `src/bin/${bin.name}.rs`,
        exposure: 'bin',
      });
  const inheritDependencies = new Set<string>();
  const dependencies = new Map<string, Dependency>();
  const collect = (data: unknown, into: Map<string, Dependency>) => {
    for (const [alias, value] of pairs(data)) {
      if (value?.workspace === true) inheritDependencies.add(alias);
      else
        into.set(alias, {
          alias,
          name: str(value?.package) ?? alias,
          requirement: str(value) ?? str(value?.version),
        });
    }
  };
  for (const config of [doc, ...pairs(doc.target).map(([, target]) => target)])
    for (const section of cargoSections) collect(config[section], dependencies);
  const shared = new Map<string, Dependency>();
  collect(doc.workspace?.dependencies, shared);
  return {
    ecosystem: 'cargo',
    name,
    version: str(pkg.version),
    description: str(pkg.description),
    private: pkg.publish === false,
    entries,
    dependencies: [...dependencies.values()],
    inheritDependencies: [...inheritDependencies],
    workspaceDependencies: [...shared.values()],
    workspaceVersion: str(doc.workspace?.package?.version),
  };
}

function add(versions: Locked, name: string, version: unknown) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) return;
  const clean = version.split('(')[0];
  const existing = (versions[name] ??= []);
  if (!existing.includes(clean)) existing.push(clean);
}

export function extractLock(name: string, text: string): Lock {
  const versions: Locked = Object.create(null);
  const importers: Record<string, Locked> = Object.create(null);
  if (name === 'Cargo.lock') {
    const doc = parseToml(text);
    for (const pkg of Array.isArray(doc.package) ? (doc.package as any[]) : [])
      if (typeof pkg.name === 'string') add(versions, pkg.name, pkg.version);
    return { ecosystem: 'cargo', versions };
  }
  for (const [pkg, entry] of Object.entries(
    lockfileIndex(name === 'npm-shrinkwrap.json' ? 'package-lock.json' : name, text, true),
  ))
    versions[pkg] = entry.versions;
  if (name === 'pnpm-lock.yaml') {
    const doc = parseYaml(text);
    for (const [path, importer] of pairs(doc?.importers ?? { '.': doc })) {
      const matches: Locked = (importers[path] = Object.create(null));
      for (const section of npmSections)
        for (const [alias, item] of pairs(objectWith(importer, section)))
          if (typeof (str(item) ?? item?.version) === 'string') {
            const version: string = str(item) ?? item.version;
            const resolved =
              version.match(/@(\d+\.\d+\.\d+[^(@/]*)(?:\(|$)/)?.[1] ??
              version.match(/-(\d+\.\d+\.\d+(?:-[\w.-]+)?)\.tgz(?:\(|$)/)?.[1] ??
              version;
            add(matches, alias, resolved);
          }
    }
  }
  if (name === 'package-lock.json' || name === 'npm-shrinkwrap.json') {
    const doc = JSON.parse(text);
    for (const [path, importer] of pairs(doc.packages)) {
      if (path.split('/').includes('node_modules')) continue;
      const matches: Locked = (importers[path || '.'] = Object.create(null));
      for (const section of npmSections)
        for (const [alias] of pairs(objectWith(importer, section)))
          add(
            matches,
            alias,
            objectWith(doc.packages, (path ? path + '/' : '') + 'node_modules/' + alias)?.version ??
              objectWith(doc.packages, 'node_modules/' + alias)?.version,
          );
    }
  }
  return { ecosystem: 'npm', versions, importers };
}
