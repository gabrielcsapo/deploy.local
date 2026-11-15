import { parse, stringify } from 'smol-toml';
import { isDeepStrictEqual } from 'node:util';
import { createReadStream } from 'node:fs';

export const CRATES_IO_INDEX = 'https://github.com/rust-lang/crates.io-index';
export function cargoConfig(origin, ca) {
  const base = new URL(origin).origin;
  return `[registries.deploy-local]\nindex = "sparse+${base}/cargo/index/"\n\n[source.crates-io]\nreplace-with = "deploy-local-crates-io"\n\n[source.deploy-local-crates-io]\nregistry = "sparse+${base}/cargo/crates-io/"\n${ca ? '\n[http]\ncainfo = ' + JSON.stringify(ca) + '\n' : ''}`;
}
/** Keep comments and unrelated lines in ordinary configs; TOML handles quoted/dotted tables too. */
export function updateCargoSetting(text, section, key, value) {
  const doc = parse(text);
  let table = doc;
  for (const part of section.split('.')) table = table[part] ||= Object.create(null);
  if (typeof table !== 'object' || Array.isArray(table))
    throw Error('Invalid Cargo configuration table');
  if (value === undefined) delete table[key];
  else table[key] = value;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${section}]`);
  let candidate;
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
    const body = lines
      .slice(start + 1, end)
      .filter(
        (line) =>
          !new RegExp('^\\s*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=').test(line),
      );
    if (value !== undefined) body.unshift(`${key} = ${JSON.stringify(value)}`);
    lines.splice(start + 1, end - start - 1, ...body);
    candidate = lines.join('\n');
  } else
    candidate =
      text.replace(/\n?$/, '\n') +
      `\n[${section}]\n${value === undefined ? '' : `${key} = ${JSON.stringify(value)}\n`}`;
  try {
    if (isDeepStrictEqual(parse(candidate), doc)) return candidate;
  } catch {
    /* Unusual TOML layout: preserve its parsed settings. */
  }
  return stringify(doc);
}
export function cargoPackage(text, workspace) {
  const doc = parse(text);
  const pkg = doc.package;
  if (!pkg || typeof pkg.name !== 'string') throw Error('Cargo.toml needs a [package] name');
  const version =
    typeof pkg.version === 'object' && pkg.version.workspace ? workspace?.version : pkg.version;
  if (typeof version !== 'string')
    throw Error('Cargo.toml needs a package version (or a workspace.package version)');
  if (
    pkg.publish === false ||
    (Array.isArray(pkg.publish) && !pkg.publish.includes('deploy-local'))
  )
    throw Error('This crate does not allow publishing to deploy-local');
  return { ...pkg, version };
}
/** Read the normalized Cargo.toml from cargo package, where workspace/path dependencies are resolved. */
export function cargoMetadata(text, index) {
  const doc = parse(text),
    pkg = cargoPackage(text);
  const deps = [];
  function dependencies(tables, target = null) {
    for (const [section, kind] of [
      ['dependencies', 'normal'],
      ['dev-dependencies', 'dev'],
      ['build-dependencies', 'build'],
    ]) {
      for (const [alias, input] of Object.entries(tables[section] || {})) {
        const dep = typeof input === 'string' ? { version: input } : input;
        if (!dep.version) throw Error(`Dependency ${alias} has no registry version`);
        const registry =
          dep['registry-index'] || (dep.registry === 'deploy-local' ? index : CRATES_IO_INDEX);
        deps.push({
          name: dep.package || alias,
          version_req: dep.version,
          features: dep.features || [],
          optional: dep.optional || false,
          default_features: dep['default-features'] ?? true,
          target,
          kind,
          registry: registry === index ? null : registry,
          explicit_name_in_toml: dep.package ? alias : null,
        });
      }
    }
  }
  dependencies(doc);
  for (const [target, tables] of Object.entries(doc.target || {})) dependencies(tables, target);
  return {
    name: pkg.name,
    vers: pkg.version,
    deps,
    features: doc.features || {},
    authors: pkg.authors || [],
    description: pkg.description ?? null,
    documentation: pkg.documentation ?? null,
    homepage: pkg.homepage ?? null,
    readme: null,
    keywords: pkg.keywords || [],
    categories: pkg.categories || [],
    license: pkg.license ?? null,
    license_file: pkg['license-file'] ?? null,
    repository: pkg.repository ?? null,
    links: pkg.links ?? null,
    rust_version: pkg['rust-version'] ?? null,
  };
}
export async function* cargoPublishBody(metadata, file, size) {
  const json = Buffer.from(JSON.stringify(metadata));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(json.length);
  yield length;
  yield json;
  const crateLength = Buffer.alloc(4);
  crateLength.writeUInt32LE(size);
  yield crateLength;
  yield* createReadStream(file);
}
