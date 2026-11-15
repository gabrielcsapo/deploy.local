import { cargoMetadata, cargoPublishBody } from '../../shared/cargo.mjs';
// Worker-only pack inspection and upload. Project commands have already exited before a
// publish token is requested; the token is never put in an environment, job file or log.
import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { getCACertificates } from 'node:tls';
const exec = promisify(execFile);
export async function finishPackageJob(
  job: any,
  cwd: string,
  credential: () => Promise<{ registry: string; key: string; ca?: string }>,
  ca = '',
  signal?: AbortSignal,
) {
  const spec = job.packagePublish;
  const root = await realpath(cwd);
  const directory = await realpath(resolve(root, spec.path, spec.destination));
  if (!directory.startsWith(root + sep))
    throw new Error('Packed package escapes the job directory');
  const cargo = spec.ecosystem === 'cargo';
  const files = (await readdir(directory)).filter((name) =>
    name.endsWith(cargo ? '.crate' : '.tgz'),
  );
  if (files.length !== 1) throw new Error('Package command must produce exactly one archive');
  const file = await realpath(resolve(directory, files[0]));
  if (!file.startsWith(directory + sep))
    throw new Error('Packed package must not be an external link');
  const size = (await stat(file)).size;
  if (size > 200 * 1024 * 1024) throw new Error('Tarball exceeds 200 MB.');
  const { stdout } = await exec(
    'tar',
    ['-xOf', file, cargo ? `${files[0].slice(0, -6)}/Cargo.toml` : 'package/package.json'],
    {
      maxBuffer: 65536,
      timeout: 10000,
      signal,
    },
  );
  const manifest = cargo
    ? cargoMetadata(stdout, 'sparse+https://deploy.local/cargo/index/')
    : JSON.parse(stdout);
  if (
    (cargo ? manifest.name.toLowerCase() : manifest.name) !== spec.name ||
    (cargo ? manifest.vers : manifest.version) !== spec.version ||
    manifest.private
  )
    throw new Error('The packed name and version do not match package.json at the pipeline commit');
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ])
    if (
      Object.values(manifest[field] || {}).some(
        (value) => typeof value === 'string' && value.startsWith('workspace:'),
      )
    )
      throw new Error('pnpm pack did not resolve workspace: dependencies');
  if (spec.checkOnly) return;
  const sha512 = createHash('sha512'),
    sha1 = createHash('sha1');
  for await (const chunk of createReadStream(file)) {
    sha512.update(chunk);
    sha1.update(chunk);
  }
  manifest.dist = { integrity: 'sha512-' + sha512.digest('base64'), shasum: sha1.digest('hex') };
  const prefix =
    JSON.stringify({
      name: manifest.name,
      versions: { [manifest.version]: manifest },
      'dist-tags': { latest: manifest.version },
    }).slice(0, -1) +
    ',"_attachments":{' +
    JSON.stringify(files[0]) +
    ':{"content_type":"application/octet-stream","length":' +
    size +
    ',"data":"';
  async function* body() {
    yield prefix;
    let carry = Buffer.alloc(0);
    for await (const chunk of createReadStream(file)) {
      const joined = Buffer.concat([carry, chunk]),
        count = joined.length - (joined.length % 3);
      yield joined.subarray(0, count).toString('base64');
      carry = joined.subarray(count);
    }
    if (carry.length) yield carry.toString('base64');
    yield '"}}}';
  }
  const config = await credential();
  const registry = new URL(config.registry);
  if (cargo)
    Object.assign(manifest, cargoMetadata(stdout, `sparse+${registry.origin}/cargo/index/`));
  if (
    registry.pathname !== '/npm/' ||
    registry.username ||
    registry.password ||
    registry.search ||
    registry.hash ||
    (!(registry.protocol === 'https:' && registry.hostname === 'deploy.local') &&
      !(registry.protocol === 'http:' && registry.hostname === '127.0.0.1'))
  )
    throw new Error('Package publishing requires the coordinator registry');
  // No redirect support: a credential cannot follow a package-controlled URL.
  await new Promise<void>((done, reject) => {
    const request = (registry.protocol === 'https:' ? httpsRequest : httpRequest)(
      new URL(cargo ? '/cargo/api/v1/crates/new' : encodeURIComponent(spec.name), registry),
      {
        method: 'PUT',
        signal,
        ...(config.ca || ca ? { ca: [...getCACertificates('default'), config.ca || ca] } : {}),
        headers: {
          Authorization: 'Bearer ' + config.key,
          'Content-Type': cargo ? 'application/octet-stream' : 'application/json',
        },
      },
      (response) => {
        let text = '';
        response.on('data', (chunk) => {
          text = (text + chunk).slice(0, 65536);
        });
        response.on('error', () => reject(new Error('Package upload response was interrupted')));
        response.on('end', () => {
          if (response.statusCode === (cargo ? 200 : 201)) return done();
          // Only registry errors, scrubbed before they can become durable job output.
          let reason = `Package publish failed (${response.statusCode})`;
          try {
            reason = JSON.parse(text).errors?.[0]?.detail || JSON.parse(text).reason || reason;
          } catch {}
          reject(
            new Error(
              String(reason)
                .replaceAll(config.key, '[redacted]')
                .replace(/dlp_[A-Za-z0-9_-]+/g, '[redacted]'),
            ),
          );
        });
      },
    );
    request.setTimeout(120000, () => request.destroy(new Error('Package upload timed out')));
    request.on('error', () =>
      reject(
        new Error(
          'Package upload failed or was cancelled; run the pipeline again to check what remains',
        ),
      ),
    );
    Readable.from(cargo ? cargoPublishBody(manifest, file, size) : body())
      .on('error', () => request.destroy())
      .pipe(request);
  });
}
