// Upstream JSON is decoded and encoded only in this worker. Until all three
// outputs are complete they live in the request's temporary directory.
import { parentPort, workerData } from 'node:worker_threads';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
let invalid = false;
try {
  const raw = await readFile(workerData.path, 'utf8');
  invalid = true;
  const doc = JSON.parse(raw);
  if (
    doc?.name !== workerData.name ||
    !doc.versions ||
    typeof doc.versions !== 'object' ||
    Array.isArray(doc.versions)
  )
    throw new Error('Invalid upstream packument');
  const index = Object.create(null);
  const abbreviated = {
    name: doc.name,
    'dist-tags': doc['dist-tags'],
    versions: Object.create(null),
  };
  const fields = [
    'name',
    'version',
    'dist',
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'peerDependenciesMeta',
    'bin',
    'engines',
    'os',
    'cpu',
    'libc',
    'deprecated',
    'hasInstallScript',
  ];
  for (const [version, value] of Object.entries(doc.versions)) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !value.dist ||
      typeof value.dist.tarball !== 'string'
    )
      throw new Error('Invalid upstream version');
    const target = new URL(value.dist.tarball);
    if (target.origin !== workerData.upstreamOrigin || target.username || target.password)
      throw new Error('Invalid upstream tarball host');
    index[version] = {
      tarball: target.href,
      integrity: value.dist.integrity,
      os: value.os,
      cpu: value.cpu,
    };
    value.dist.tarball =
      // Scoped names stay unencoded, as on npmjs.org: pnpm treats any other form as a
      // non-standard URL, writes it into lockfiles, and refuses it for its own package.
      workerData.publicBase +
      doc.name +
      '/-/' +
      encodeURIComponent(doc.name.split('/').pop() + '-' + version + '.tgz');
    abbreviated.versions[version] = Object.fromEntries(
      fields.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]),
    );
  }
  invalid = false;
  const files = {};
  for (const [kind, value] of Object.entries({ full: doc, abbreviated, index })) {
    const bytes = Buffer.from(JSON.stringify(value));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(workerData.directory, kind), bytes, { flag: 'wx', mode: 0o600 });
    files[kind] = { sha256, size: bytes.length };
  }
  parentPort.postMessage({ files, versions: Object.keys(index) });
} catch {
  // Do not relay upstream JSON, URLs or credentials in worker errors.
  parentPort.postMessage({
    error: invalid ? 'Invalid upstream packument' : 'Package preparation failed',
    invalid,
  });
}
