import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CargoCopy, crateName, indexPath, type CargoSettings } from './cargo-copy.ts';
import { audit, canPublish, registryIdentity, type Identity } from './keys.ts';
import { npmRegistryUrl } from './npm-login.ts';
import { packageProject } from './projects.ts';
import {
  db,
  fail,
  limiter,
  MAX_DOC,
  MAX_FILE,
  now,
  packageByName,
  sendFile,
  served,
  storeFile,
  tempRoot,
  versionOf,
  versions,
  type Package,
} from './store.ts';

/** Cargo publish metadata differs from index metadata, especially renamed dependencies. */
export function cargoIndex(metadata: any, checksum: string) {
  if (
    !metadata ||
    !Array.isArray(metadata.deps) ||
    !metadata.features ||
    typeof metadata.features !== 'object' ||
    Array.isArray(metadata.features)
  )
    fail('Invalid Cargo publish metadata', 422);
  const features: Record<string, string[]> = Object.create(null),
    features2: Record<string, string[]> = Object.assign(Object.create(null), metadata.features2);
  if (
    Object.values(features2).some(
      (values) => !Array.isArray(values) || values.some((value) => typeof value !== 'string'),
    )
  )
    fail('Invalid Cargo features', 422);
  for (const [name, values] of Object.entries(metadata.features) as [string, string[]][]) {
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string'))
      fail('Invalid Cargo features', 422);
    (values.some((value) => value.startsWith('dep:') || value.includes('?/'))
      ? features2
      : features
    )[name] = values;
  }
  return {
    name: crateName(metadata.name),
    vers: versionOf(metadata.vers),
    deps: metadata.deps.map((dep: any) => {
      if (!dep || typeof dep !== 'object') fail('Invalid dependency', 422);
      crateName(dep.name);
      if (dep.explicit_name_in_toml) crateName(dep.explicit_name_in_toml);
      if (typeof dep.version_req !== 'string') fail('Invalid dependency requirement', 422);
      return {
        name: dep.explicit_name_in_toml || dep.name,
        req: dep.version_req,
        features: dep.features || [],
        optional: dep.optional ?? false,
        default_features: dep.default_features ?? true,
        target: dep.target ?? null,
        kind: dep.kind ?? 'normal',
        registry: dep.registry ?? null,
        ...(dep.explicit_name_in_toml ? { package: dep.name } : {}),
      };
    }),
    cksum: checksum,
    features,
    yanked: false,
    links: metadata.links ?? null,
    v: Object.keys(features2).length ? 2 : 1,
    ...(Object.keys(features2).length ? { features2 } : {}),
    ...(metadata.rust_version ? { rust_version: metadata.rust_version } : {}),
  };
}
// Its own copy of npm.ts's send: importing npm.ts would make an import cycle through copies.ts.
function send(res: ServerResponse, value: unknown, status = 200) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'private, no-cache',
  });
  res.end(JSON.stringify(value));
}
let active = 0;
async function publishBody(req: IncomingMessage) {
  if (active >= 2) fail('Two publishes are already being read. Try again shortly.', 429);
  active++;
  const path = join(tempRoot(), randomUUID());
  try {
    await mkdir(tempRoot(), { recursive: true, mode: 0o700 });
    await pipeline(
      Readable.from(req.iterator({ destroyOnReturn: false })),
      limiter(MAX_FILE + MAX_DOC + 8),
      createWriteStream(path, { flags: 'wx', mode: 0o600 }),
      { signal: AbortSignal.timeout(600000) },
    );
    const handle = await open(path, 'r');
    let metadata: any, start: number, size: number;
    try {
      const total = (await handle.stat()).size;
      const length = Buffer.alloc(4);
      if ((await handle.read(length, 0, 4, 0)).bytesRead !== 4)
        fail('Invalid Cargo publish body', 422);
      const jsonSize = length.readUInt32LE();
      if (jsonSize > MAX_DOC || jsonSize + 8 > total) fail('Invalid Cargo metadata length', 422);
      const json = Buffer.alloc(jsonSize);
      await handle.read(json, 0, jsonSize, 4);
      try {
        metadata = JSON.parse(json.toString());
      } catch {
        fail('Invalid Cargo publish JSON', 422);
      }
      await handle.read(length, 0, 4, 4 + jsonSize);
      size = length.readUInt32LE();
      start = 8 + jsonSize;
      if (!size || size > MAX_FILE || start + size !== total)
        fail('Invalid Cargo crate length', 422);
    } finally {
      await handle.close();
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path, { start })) hash.update(chunk);
    const checksum = hash.digest('hex');
    return { metadata, checksum, path, start, dispose: () => rm(path, { force: true }) };
  } catch (error) {
    req.resume();
    await rm(path, { force: true });
    throw error;
  } finally {
    active--;
  }
}
export function yankCrate(
  identity: Identity,
  pkg: Package,
  version: string,
  yanked: boolean,
  req?: IncomingMessage,
) {
  if (identity.pipeline) fail('Pipeline tokens can only publish new versions.', 403);
  canPublish(identity, pkg.created_by);
  if (
    !db()
      .prepare('UPDATE package_versions SET yanked=? WHERE package_id=? AND version=?')
      .run(Number(yanked), pkg.id, version).changes
  )
    fail('Version not found', 404);
  audit(identity, yanked ? 'yank' : 'unyank', pkg.name + '@' + version, req);
}
export function createCargoRegistry(settings: CargoSettings = {}) {
  const copy = new CargoCopy(settings);
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const raw = (req.url || '').split('?')[0];
    if (!raw.startsWith('/cargo/')) return false;
    try {
      const read = req.method === 'GET' || req.method === 'HEAD';
      const identity = registryIdentity(req);
      if (!read && !identity) fail('Run deploy packages login to publish or yank crates.', 401);
      if (
        identity?.pipeline &&
        ((identity.pipeline.ecosystem || 'npm') !== 'cargo' ||
          req.method !== 'PUT' ||
          raw !== '/cargo/api/v1/crates/new')
      )
        fail('Pipeline tokens can only publish their assigned package version.', 403);
      let path: string;
      try {
        path = decodeURIComponent(raw);
      } catch {
        fail('Invalid Cargo URL');
      }
      const base = new URL('/cargo', npmRegistryUrl(req)).href;
      if (
        read &&
        (path === '/cargo/index/config.json' || path === '/cargo/crates-io/config.json')
      ) {
        send(
          res,
          path.includes('/crates-io/')
            ? { dl: base + '/crates-io/api/v1/crates' }
            : { dl: base + '/api/v1/crates', api: base },
        );
      } else if (req.method === 'PUT' && path === '/cargo/api/v1/crates/new') {
        canPublish(identity!);
        const input = await publishBody(req);
        try {
          const line = cargoIndex(input.metadata, input.checksum);
          const name = line.name.toLowerCase(),
            version = line.vers;
          const existing = packageByName(name, 'cargo');
          canPublish(identity!, existing?.created_by);
          if (
            identity!.pipeline &&
            (identity!.pipeline.name !== name ||
              identity!.pipeline.version !== version ||
              (existing && existing.project_id !== identity!.pipeline.projectId))
          )
            fail('This pipeline token cannot publish this crate version.', 403);
          if (existing && versions(existing.id).some((row) => row.version === version))
            fail(`${version} is already published. Nothing changed.`, 409);
          const prior = existing
            ? (db()
                .prepare(
                  'SELECT COALESCE(SUM(length(CAST(manifest AS BLOB))),0) AS bytes FROM package_versions WHERE package_id=?',
                )
                .get(existing.id) as { bytes: number })
            : { bytes: 0 };
          if (
            prior.bytes +
              Buffer.byteLength(JSON.stringify(input.metadata)) +
              Buffer.byteLength(JSON.stringify(line)) >
            MAX_DOC
          )
            fail('Crate index exceeds 10 MB.', 413);
          const file = await storeFile(
            createReadStream(input.path, { start: input.start }),
            'hosted',
            'sha256-' + Buffer.from(input.checksum, 'hex').toString('base64'),
          );
          const projectId =
            identity!.pipeline?.projectId ??
            (await packageProject(identity!.username, input.metadata.repository));
          if (!registryIdentity(req))
            fail('Package credential expired or run ended. Run deploy packages login.', 401);
          db().transaction(() => {
            const pkg = packageByName(name, 'cargo');
            canPublish(identity!, pkg?.created_by);
            if (identity!.pipeline && pkg && pkg.project_id !== projectId)
              fail('This crate belongs to another project.', 403);
            if (pkg && versions(pkg.id).some((row) => row.version === version))
              fail(`${version} is already published. Nothing changed.`, 409);
            const id = pkg?.id || randomUUID();
            if (!pkg)
              db()
                .prepare(
                  "INSERT INTO packages(id,ecosystem,name,project_id,created_by,created_at) VALUES(?,'cargo',?,?,?,?)",
                )
                .run(id, name, projectId, identity!.username, now());
            const manifest = {
              ...input.metadata,
              index: line,
              ...(identity!.pipeline
                ? {
                    _deployPipeline: {
                      id: identity!.pipeline.pipelineId,
                      pullNumber: identity!.pipeline.pullNumber,
                    },
                  }
                : {}),
            };
            db()
              .prepare(
                'INSERT INTO package_versions(package_id,version,sha256,integrity,size,manifest,published_by,published_via,"commit",created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
              )
              .run(
                id,
                version,
                file.sha256,
                file.integrity,
                file.size,
                JSON.stringify(manifest),
                identity!.username,
                identity!.pipeline ? 'release' : 'person',
                identity!.pipeline?.commit ?? null,
                now(),
              );
          })();
          audit(identity!, 'publish', name + '@' + version, req);
          send(res, { warnings: { invalid_categories: [], invalid_badges: [], other: [] } });
        } finally {
          await input.dispose();
        }
      } else {
        const action = path.match(/^\/cargo\/api\/v1\/crates\/([^/]+)\/([^/]+)\/(yank|unyank)$/);
        const download = path.match(
          /^\/cargo\/(crates-io\/)?api\/v1\/crates\/([^/]+)\/([^/]+)\/download$/,
        );
        if (
          action &&
          ((req.method === 'DELETE' && action[3] === 'yank') ||
            (req.method === 'PUT' && action[3] === 'unyank'))
        ) {
          const pkg = packageByName(crateName(action[1]).toLowerCase(), 'cargo');
          if (!pkg) fail('Crate not found', 404);
          yankCrate(identity!, pkg, versionOf(action[2]), action[3] === 'yank', req);
          send(res, { ok: true });
        } else if (read && download) {
          const name = crateName(download[2]).toLowerCase(),
            version = versionOf(download[3]);
          if (download[1]) {
            const opened = await copy.open('file', await copy.download(name, version));
            try {
              await sendFile(
                req,
                res,
                'cache',
                opened.row,
                'application/octet-stream',
                opened.handle,
              );
            } finally {
              await opened.handle.close();
            }
          } else {
            const pkg = packageByName(name, 'cargo');
            const row = pkg && versions(pkg.id).find((candidate) => candidate.version === version);
            if (!row) fail('Crate version not found', 404);
            await sendFile(req, res, 'hosted', row);
          }
        } else if (read && /^\/cargo\/(index|crates-io)\//.test(path)) {
          const [, , registry, ...parts] = path.split('/');
          const name = crateName(parts.at(-1)!).toLowerCase();
          if (parts.join('/') !== indexPath(name)) fail('Invalid sparse index path', 404);
          if (registry === 'crates-io') {
            const opened = await copy.open('doc', await copy.document(name));
            try {
              await sendFile(req, res, 'docs', opened.row, 'text/plain', opened.handle);
            } finally {
              await opened.handle.close();
            }
          } else {
            const pkg = packageByName(name, 'cargo');
            if (!pkg) fail('Crate not found', 404);
            const bytes =
              versions(pkg.id)
                .reverse()
                .map((row) =>
                  JSON.stringify({ ...JSON.parse(row.manifest).index, yanked: !!row.yanked }),
                )
                .join('\n') + '\n';
            const etag = '"' + createHash('sha256').update(bytes).digest('hex') + '"';
            res.writeHead(req.headers['if-none-match'] === etag ? 304 : 200, {
              'Content-Type': 'text/plain',
              ETag: etag,
              'Cache-Control': 'no-cache',
            });
            res.end(
              req.headers['if-none-match'] === etag || req.method === 'HEAD' ? undefined : bytes,
            );
          }
        } else fail('Cargo endpoint not found', 404);
      }
      served();
    } catch (error: any) {
      if (res.headersSent) res.destroy();
      else send(res, { errors: [{ detail: error.message }] }, error.status || 500);
    }
    return true;
  }
  return { handle, copy };
}
export const cargoRegistry = createCargoRegistry();
