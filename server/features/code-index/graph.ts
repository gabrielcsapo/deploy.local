import { createHash } from 'node:crypto';
import { dirname, join, normalize, relative } from 'node:path/posix';
import { expand, type openIndex } from './database.ts';
import type {
  Binding,
  Confidence,
  Dependency,
  Ecosystem,
  ExtractedFile,
  Manifest,
  Source,
} from './model.ts';

type Db = ReturnType<typeof openIndex>;
type SourceRow = { path: string; kind: string; source: Source };
type ManifestRow = Manifest & { project: string; path: string; folder: string };
type Target = { project: string; path: string; offset: number };
type Module = { project: string; path: string; scope?: string[] };
type Link = Dependency & {
  manifest: ManifestRow;
  versions: string[];
  producer?: ManifestRow;
  places: number;
  files: Set<string>;
  names: Map<string, number>;
};
const packageKey = (ecosystem: Ecosystem, name: string) => ecosystem + ':' + name;
const fromRoot = (path: string) => normalize(path).replace(/^\.\//, '');
const packageSplit = (specifier: string) => {
  const parts = specifier.split('/');
  const count = specifier.startsWith('@') ? 2 : 1;
  return { name: parts.slice(0, count).join('/'), subpath: parts.slice(count).join('/') };
};
const ascend = function* (folder: string) {
  for (let current = folder; ; current = dirname(current)) {
    yield current;
    if (current === '.') return;
  }
};
const distinct = <T>(values: T[]) => [...new Set(values)];
const bestNames = (names: Map<string, number>) =>
  [...names]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, 3)
    .map(([name]) => name);

function matches(files: Set<string>, path: string) {
  if (files.has(path)) return path;
  const stem = path.replace(/(?:\.d)?\.[cm]?[jt]sx?$/i, '');
  const stems = distinct([
    stem,
    stem.replace(/(^|\/)(?:dist|lib|build)\//, '$1src/'),
    stem.replace(/(^|\/)dist\//, '$1'),
  ]);
  for (const candidate of stems)
    for (const suffix of [
      '',
      '.ts',
      '.tsx',
      '.mts',
      '.cts',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
      '.d.ts',
      '.d.mts',
      '.d.cts',
      '/index.ts',
      '/index.tsx',
      '/index.js',
      '/index.d.ts',
    ])
      if (files.has(candidate + suffix)) return candidate + suffix;
}

class ProjectSources {
  readonly paths: Set<string>;
  private readonly cache = new Map<string, SourceRow | null>();
  private readonly db: Db;
  private readonly owner: string;
  readonly project: string;
  constructor(db: Db, owner: string, project: string) {
    this.db = db;
    this.owner = owner;
    this.project = project;
    this.paths = new Set(
      (
        db
          .prepare("SELECT path FROM code_files WHERE owner=? AND project=? AND coverage='symbols'")
          .all(owner, project) as { path: string }[]
      ).map(({ path }) => path),
    );
  }

  read(path: string) {
    if (!this.paths.has(path)) return null;
    const row = this.db
      .prepare('SELECT kind,data FROM code_files WHERE owner=? AND project=? AND path=?')
      .get(this.owner, this.project, path) as { kind: string; data: Buffer };
    const { source } = JSON.parse(expand(row.data)) as ExtractedFile;
    return source ? { path, kind: row.kind, source } : null;
  }

  get(path: string) {
    if (!this.paths.has(path)) return null;
    if (!this.cache.has(path)) {
      const row = this.read(path);
      if (row) {
        const targets = new Set(
          row.source.exports.flatMap((item) => (item.target === undefined ? [] : [item.target])),
        );
        row.source = {
          exports: row.source.exports,
          occurrences: [],
          definitions:
            row.kind === 'Rust'
              ? row.source.definitions
              : row.source.definitions.filter((item) => targets.has(item.offset)),
        };
      }
      this.cache.set(path, row);
    }
    return this.cache.get(path) ?? null;
  }
}

class SourceGraph {
  private readonly contexts = new Map<string, ProjectSources>();
  readonly manifests: ManifestRow[] = [];
  readonly packages = new Map<string, ManifestRow[]>();
  readonly manifestDirectories = new Map<string, ManifestRow>();
  readonly links = new Map<string, Map<string, Link>>();
  private readonly locks = new Map<string, NonNullable<ExtractedFile['lock']>>();
  private readonly exportNamesCache = new Map<string, string[]>();
  private readonly moduleCache = new Map<string, { modules: Module[]; link?: Link }>();

  private readonly db: Db;
  private readonly owner: string;
  constructor(db: Db, owner: string, active: Set<string>) {
    this.db = db;
    this.owner = owner;
    for (const row of db
      .prepare("SELECT project,path,data FROM code_files WHERE owner=? AND coverage='packages'")
      .iterate(owner) as Iterable<{ project: string; path: string; data: Buffer }>) {
      if (!active.has(row.project)) continue;
      const { manifest, lock } = JSON.parse(expand(row.data)) as ExtractedFile;
      const folder = dirname(row.path);
      if (lock) {
        const key = JSON.stringify([row.project, folder, lock.ecosystem]);
        // Prefer the first lockfile deterministically if multiple package managers are present.
        if (!this.locks.has(key)) this.locks.set(key, lock);
      }
      if (!manifest) continue;
      const entry = { ...manifest, project: row.project, path: row.path, folder };
      this.manifests.push(entry);
      this.manifestDirectories.set(
        JSON.stringify([row.project, folder, manifest.ecosystem]),
        entry,
      );
      if (manifest.name) {
        const key = packageKey(manifest.ecosystem, manifest.name);
        const publishers = this.packages.get(key) ?? [];
        publishers.push(entry);
        this.packages.set(key, publishers);
      }
    }
    for (const manifest of this.manifests) {
      if (manifest.ecosystem === 'cargo' && !manifest.version)
        manifest.version = this.workspaceOf(manifest)?.workspaceVersion;
    }
    for (const manifest of this.manifests) {
      const workspace = this.workspaceOf(manifest);
      const inherited = new Set(manifest.inheritDependencies);
      const dependencies = [
        ...manifest.dependencies,
        ...(workspace?.workspaceDependencies?.filter(({ alias }) => inherited.has(alias)) ?? []),
      ];
      const links = new Map<string, Link>();
      this.links.set(this.key(manifest), links);
      for (const dependency of dependencies) {
        const versions = this.locked(manifest, dependency);
        const publishers = (
          this.packages.get(packageKey(manifest.ecosystem, dependency.name)) ?? []
        ).filter((candidate) => !candidate.private || candidate.project === manifest.project);
        const local = publishers.filter(({ project }) => project === manifest.project);
        const exact = publishers.filter(({ version }) => version && versions.includes(version));
        const producer =
          local.length === 1
            ? local[0]
            : exact.length === 1
              ? exact[0]
              : publishers.length === 1
                ? publishers[0]
                : undefined;
        links.set(dependency.alias, {
          ...dependency,
          manifest,
          versions,
          producer,
          places: 0,
          files: new Set(),
          names: new Map(),
        });
      }
    }
  }

  context(project: string) {
    if (!this.contexts.has(project))
      this.contexts.set(project, new ProjectSources(this.db, this.owner, project));
    return this.contexts.get(project)!;
  }

  key(manifest: ManifestRow) {
    return JSON.stringify([manifest.project, manifest.path]);
  }

  private workspaceOf(manifest: ManifestRow) {
    for (const folder of ascend(manifest.folder)) {
      const candidate = this.manifestDirectories.get(
        JSON.stringify([manifest.project, folder, manifest.ecosystem]),
      );
      if (candidate?.workspaceVersion || candidate?.workspaceDependencies?.length) return candidate;
    }
  }

  private locked(manifest: ManifestRow, dependency: Dependency): string[] {
    for (const folder of ascend(manifest.folder)) {
      const lock = this.locks.get(JSON.stringify([manifest.project, folder, manifest.ecosystem]));
      if (lock) {
        const importer = lock.importers?.[relative(folder, manifest.folder) || '.'];
        const versions =
          importer?.[dependency.alias] ??
          lock.versions[dependency.name] ??
          lock.versions[dependency.alias];
        if (versions?.length) return versions;
      }
    }
    const version =
      dependency.requirement?.match(/^(?:=|npm:.+@)?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/)?.[1] ??
      dependency.requirement?.match(/\/(?:[^/]+-)(\d+\.\d+\.\d+(?:-[\w.-]+)?)\.tgz(?:$|[?#])/)?.[1];
    return version && manifest.ecosystem === 'npm' ? [version] : [];
  }

  manifestFor(module: Module, ecosystem: Ecosystem) {
    for (const folder of ascend(dirname(module.path))) {
      const manifest = this.manifestDirectories.get(
        JSON.stringify([module.project, folder, ecosystem]),
      );
      if (manifest) return manifest;
    }
  }

  resolveEntry(manifest: ManifestRow, entry: Manifest['entries'][number], wildcard = '') {
    const path = fromRoot(join(manifest.folder, entry.path.replaceAll('*', wildcard)));
    const files = this.context(manifest.project).paths;
    return manifest.ecosystem === 'cargo'
      ? files.has(path)
        ? path
        : undefined
      : matches(files, path);
  }

  private npmModule(origin: Module, specifier: string) {
    const key = JSON.stringify([origin.project, dirname(origin.path), specifier]);
    let value = this.moduleCache.get(key);
    if (!value) {
      value = this.findNpmModule(origin, specifier);
      if (this.moduleCache.size < 100_000) this.moduleCache.set(key, value);
    }
    return value;
  }

  private findNpmModule(origin: Module, specifier: string): { modules: Module[]; link?: Link } {
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const module = matches(
        this.context(origin.project).paths,
        join(dirname(origin.path), specifier),
      );
      return { modules: module ? [{ project: origin.project, path: module }] : [] };
    }
    const { name, subpath } = packageSplit(specifier);
    const consumer = this.manifestFor(origin, 'npm');
    const link = consumer && this.links.get(this.key(consumer))?.get(name);
    const publisher = link?.producer ?? (consumer?.name === name ? consumer : undefined);
    if (!publisher) return { modules: [], link };
    const entryName = subpath ? './' + subpath : '.';
    const paths = publisher.entries.flatMap((entry) => {
      if (entry.exposure !== 'import') return [];
      const [prefix, suffix] = entry.name.split('*');
      const wildcard =
        suffix !== undefined && entryName.startsWith(prefix) && entryName.endsWith(suffix)
          ? entryName.slice(prefix.length, entryName.length - suffix.length)
          : undefined;
      if (entry.name !== entryName && wildcard === undefined) return [];
      const file = this.resolveEntry(publisher, entry, wildcard);
      return file ? [file] : [];
    });
    if (!paths.length && subpath && publisher.wildcardEntries) {
      const file = matches(this.context(publisher.project).paths, join(publisher.folder, subpath));
      if (file) paths.push(file);
    }
    return { link, modules: distinct(paths).map((path) => ({ project: publisher.project, path })) };
  }

  private rustModules(
    origin: Module,
    path: string[],
    external: boolean,
  ): { modules: Module[]; link?: Link; publicOnly?: boolean } {
    const manifest = this.manifestFor(origin, 'cargo');
    const alias = path[0];
    const dependencies = manifest && this.links.get(this.key(manifest));
    const link =
      external && alias && dependencies
        ? [...dependencies.values()].find((item) => item.alias.replaceAll('-', '_') === alias)
        : undefined;
    if (link) {
      const publisher = link.producer;
      const entry = publisher?.entries.find((item) => item.exposure === 'import');
      const root = publisher && entry && this.resolveEntry(publisher, entry);
      if (!root) return { link, modules: [], publicOnly: true };
      const trail = path.slice(1);
      const accessible = trail.every((name, index) =>
        this.rustAt(publisher.project, root, trail.slice(0, index)).some((module) =>
          this.context(module.project)
            .get(module.path)
            ?.source.exports.some(
              (item) =>
                item.name === name &&
                (item.scope ?? []).join('::') === (module.scope ?? []).join('::'),
            ),
        ),
      );
      return {
        link,
        modules: accessible ? this.rustAt(publisher.project, root, trail) : [],
        publicOnly: true,
      };
    }
    const root =
      manifest?.entries
        .map((entry) => this.resolveEntry(manifest, entry))
        .filter(
          (entry): entry is string =>
            !!entry && (origin.path === entry || origin.path.startsWith(dirname(entry) + '/')),
        )
        .sort(
          (a, b) => Number(b === origin.path) - Number(a === origin.path) || b.length - a.length,
        )[0] ?? origin.path;
    const crateFolder = dirname(root);
    const fileScope =
      origin.path === root
        ? []
        : relative(crateFolder, origin.path)
            .replace(/(?:\/mod)?\.rs$/, '')
            .split('/');
    const scope = [...fileScope, ...(origin.scope ?? [])];
    const trail = [...path];
    let start = scope;
    if (trail[0] === 'crate') {
      trail.shift();
      start = [];
    } else if (trail[0] === 'self') trail.shift();
    else if (trail[0] === 'super') {
      start = [...scope];
      while (trail[0] === 'super') {
        trail.shift();
        start.pop();
      }
    }
    return { modules: this.rustAt(origin.project, root, [...start, ...trail]) };
  }

  private rustAt(project: string, root: string, trail: string[]) {
    const paths = this.context(project).paths;
    const modules: Module[] = [];
    for (let length = trail.length; length >= 0; length--) {
      const path = join(dirname(root), ...trail.slice(0, length));
      const file = length
        ? [path + '.rs', join(path, 'mod.rs')].find((candidate) => paths.has(candidate))
        : root;
      if (file) modules.push({ project, path: file, scope: trail.slice(length) });
    }
    return modules;
  }

  resolve(
    origin: Module,
    ecosystem: Ecosystem,
    binding: Binding,
    seen = new Set<string>(),
  ): { target?: Target; link?: Link; name: string } {
    const name = binding.member ?? binding.name;
    if (ecosystem === 'cargo' && !binding.module) {
      const dependency = this.rustModules(origin, [name], true);
      if (dependency.link) return { link: dependency.link, name: '' };
    }
    const { modules, link, publicOnly } =
      ecosystem === 'cargo'
        ? this.rustModules(origin, binding.module ? binding.module.split('::') : [], true)
        : { ...this.npmModule(origin, binding.module), publicOnly: true };
    if (!name || name === '*') return { link, name };
    for (const module of modules) {
      const target = this.exported(
        module,
        ecosystem,
        name,
        seen,
        publicOnly,
        binding.member ? binding.name : undefined,
      );
      if (target) return { target, link, name };
    }
    return { link, name };
  }

  private exported(
    module: Module,
    ecosystem: Ecosystem,
    name: string,
    seen: Set<string>,
    publicOnly = true,
    namespace?: string,
  ): Target | undefined {
    const key = JSON.stringify([module, name, namespace, publicOnly]);
    if (seen.size >= 64 || seen.has(key)) return;
    seen.add(key);
    try {
      const row = this.context(module.project).get(module.path);
      if (!row) return;
      const sameScope = (scope?: string[]) =>
        (scope ?? []).join('::') === (module.scope ?? []).join('::');
      const exports = row.source.exports.filter((item) => sameScope(item.scope));
      const qualifier = namespace && namespace !== '*' ? namespace : undefined;
      const lookupName = qualifier ?? name;
      const explicit = exports.filter(
        (item) => item.name === lookupName || (lookupName === 'default' && item.name === 'export='),
      );
      for (const item of explicit) {
        if (item.target !== undefined && !qualifier)
          return { project: module.project, path: module.path, offset: item.target };
        if (item.binding) {
          const link = qualifier ? { ...item.binding, member: name } : item.binding;
          const target = this.resolve(module, ecosystem, link, seen).target;
          if (target) return target;
        } else if (qualifier) {
          const definition = row.source.definitions.find(
            (candidate) => candidate.offset === item.target,
          );
          if (definition?.kind === 'namespace') {
            const target = this.exported(
              { ...module, scope: [...(module.scope ?? []), definition.name] },
              ecosystem,
              name,
              seen,
            );
            if (target) return target;
          }
        }
      }
      if (ecosystem === 'cargo' && !publicOnly) {
        const definition = row.source.definitions.find(
          (item) => item.name === name && sameScope(item.scope),
        );
        if (definition)
          return { project: module.project, path: module.path, offset: definition.offset };
      }
      if (name === 'default' || explicit.length) return;
      let match: Target | undefined;
      for (const item of exports) {
        if (item.name !== '*' || !item.binding) continue;
        const target = this.resolve(
          module,
          ecosystem,
          { ...item.binding, name: lookupName, member: qualifier ? name : undefined },
          seen,
        ).target;
        if (!target) continue;
        if (
          match &&
          (match.project !== target.project ||
            match.path !== target.path ||
            match.offset !== target.offset)
        )
          return;
        match = target;
      }
      return match;
    } finally {
      seen.delete(key);
    }
  }

  exportNames(origin: Module, ecosystem: Ecosystem, seen = new Set<string>()) {
    const key = JSON.stringify(origin);
    if (!seen.size && this.exportNamesCache.has(key)) return this.exportNamesCache.get(key)!;
    if (seen.size >= 64 || seen.has(key)) return [];
    seen.add(key);
    const names = new Set<string>();
    for (const item of this.context(origin.project).get(origin.path)?.source.exports ?? []) {
      if ((item.scope ?? []).join('::') !== (origin.scope ?? []).join('::')) continue;
      if (item.name !== '*') names.add(item.name);
      else if (item.binding) {
        const { modules } =
          ecosystem === 'cargo'
            ? this.rustModules(origin, item.binding.module.split('::'), true)
            : this.npmModule(origin, item.binding.module);
        for (const module of modules)
          for (const name of this.exportNames(module, ecosystem, seen))
            if (name !== 'default') names.add(name);
      }
    }
    seen.delete(key);
    const result = [...names];
    if (!seen.size) this.exportNamesCache.set(key, result);
    return result;
  }

  materialize(project: string, changed?: Set<string>) {
    const db = this.db;
    const owner = this.owner;
    for (const table of ['code_dependencies', 'code_exports'])
      db.prepare(`DELETE FROM ${table} WHERE owner=? AND project=?`).run(owner, project);
    if (changed) {
      for (const table of ['code_packages', 'code_entries'])
        db.prepare(`DELETE FROM ${table} WHERE owner=? AND project=?`).run(owner, project);
      const remove = db.prepare('DELETE FROM code_symbols WHERE owner=? AND project=? AND path=?');
      const removeRefs = db.prepare(
        'DELETE FROM code_references WHERE owner=? AND project=? AND path=?',
      );
      for (const path of changed) {
        remove.run(owner, project, path);
        removeRefs.run(owner, project, path);
      }
    }
    db.prepare(
      "DELETE FROM code_references WHERE owner=? AND project=? AND confidence<>'checker'",
    ).run(owner, project);
    const definition = db.prepare(
      'INSERT OR IGNORE INTO code_symbols VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    );
    const reference = db.prepare(
      'INSERT OR IGNORE INTO code_references VALUES (?,?,?,?,?,?,?,?,?,?)',
    );
    const exported = db.prepare('INSERT OR IGNORE INTO code_exports VALUES (?,?,?,?,?,?,?)');
    const entry = db.prepare('INSERT OR IGNORE INTO code_entries VALUES (?,?,?,?,?,?)');
    const pkg = db.prepare('INSERT INTO code_packages VALUES (?,?,?,?,?,?,?)');
    const dependency = db.prepare(
      'INSERT INTO code_dependencies VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    const context = this.context(project);
    for (const manifest of this.manifests.filter((row) => changed && row.project === project)) {
      if (manifest.name)
        pkg.run(
          owner,
          project,
          manifest.path,
          manifest.ecosystem,
          manifest.name,
          manifest.version ?? null,
          manifest.description ?? null,
        );
      for (const item of manifest.entries) {
        const file = this.resolveEntry(manifest, item);
        // Explicit paths are meaningful even when they are build outputs.
        if (
          file ||
          (manifest.ecosystem === 'npm' && item.path !== 'index') ||
          item.path.includes('/bin/')
        )
          entry.run(owner, project, manifest.path, item.name, file ?? item.path, item.exposure);
      }
    }
    for (const path of context.paths) {
      const row = context.read(path);
      if (!row) continue;
      const ecosystem = row.kind === 'Rust' ? 'cargo' : 'npm';
      const origin = { project, path };
      if (changed?.has(path))
        for (const item of row.source.definitions)
          definition.run(
            owner,
            project,
            path,
            item.offset,
            item.name,
            item.kind,
            item.line,
            item.column,
            item.signature,
            item.doc ?? null,
            createHash('sha256')
              .update(JSON.stringify([path, item.offset]))
              .digest('base64url'),
          );
      for (const scope of distinct([
        '',
        ...row.source.exports.map((item) => item.scope?.join('::') ?? ''),
      ])) {
        const module = scope ? { ...origin, scope: scope.split('::') } : origin;
        for (const name of this.exportNames(module, ecosystem)) {
          const target = this.exported(module, ecosystem, name, new Set());
          if (target)
            exported.run(
              owner,
              project,
              path,
              scope ? scope + '::' + name : name,
              target.project,
              target.path,
              target.offset,
            );
        }
      }
      for (const item of row.source.occurrences) {
        let confidence: Confidence = ecosystem === 'cargo' ? 'path' : 'checker';
        let target = item.target === undefined ? undefined : { project, path, offset: item.target };
        if (confidence === 'checker' && !item.binding && !changed?.has(path)) continue;
        if (item.binding) {
          const result = this.resolve(
            item.scope?.length ? { ...origin, scope: item.scope } : origin,
            ecosystem,
            item.binding,
          );
          target = result.target;
          if (ecosystem === 'npm') confidence = 'module';
          if (result.link && (target || !item.binding.optionalMember)) {
            result.link.places++;
            result.link.files.add(path);
            if (result.name && result.name !== '*')
              result.link.names.set(result.name, (result.link.names.get(result.name) ?? 0) + 1);
          }
        }
        if (target)
          reference.run(
            owner,
            project,
            path,
            item.offset,
            item.line,
            item.column,
            target.project,
            target.path,
            target.offset,
            confidence,
          );
      }
    }
    for (const manifest of this.manifests.filter((row) => row.project === project)) {
      for (const link of this.links.get(this.key(manifest))?.values() ?? [])
        dependency.run(
          owner,
          project,
          manifest.path,
          manifest.ecosystem,
          link.alias,
          link.name,
          link.requirement ?? null,
          JSON.stringify(link.versions),
          link.producer?.project ?? null,
          link.producer?.version ?? null,
          link.places,
          link.files.size,
          JSON.stringify(bestNames(link.names)),
        );
    }
  }
}

/** Re-resolve the changed project and consumers of any package it used to or now publishes.
 * Repeat through consumers that publish packages of their own, since they may re-export it. */
export function updateGraph(
  db: Db,
  owner: string,
  project: string,
  active: Set<string>,
  paths: Set<string>,
) {
  const graph = new SourceGraph(db, owner, active);
  const affected = new Set([project]);
  const oldNames = db.prepare(
    'SELECT ecosystem,name FROM code_packages WHERE owner=? AND project=?',
  );
  const consumers = db.prepare(
    'SELECT DISTINCT project FROM code_dependencies WHERE owner=? AND ecosystem=? AND name=?',
  );
  const currentConsumers = new Map<string, Set<string>>();
  for (const links of graph.links.values())
    for (const link of links.values()) {
      const key = packageKey(link.manifest.ecosystem, link.name);
      const projects = currentConsumers.get(key) ?? new Set<string>();
      projects.add(link.manifest.project);
      currentConsumers.set(key, projects);
    }
  for (const item of affected) {
    const published = [
      ...(oldNames.all(owner, item) as { ecosystem: Ecosystem; name: string }[]),
      ...graph.manifests.filter((row) => row.project === item),
    ];
    for (const { ecosystem, name } of published) {
      if (!name) continue;
      for (const candidate of currentConsumers.get(packageKey(ecosystem, name)) ?? [])
        affected.add(candidate);
      for (const row of consumers.all(owner, ecosystem, name) as { project: string }[])
        if (active.has(row.project)) affected.add(row.project);
    }
  }
  for (const item of affected) graph.materialize(item, item === project ? paths : undefined);
}
