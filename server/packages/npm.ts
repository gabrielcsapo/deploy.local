import { npmRegistryUrl, startNpmLogin, pollNpmLogin } from './npm-login.ts';
import { sendJson } from '../kernel/http.ts';
import { pinComputerInstall } from './copies.ts';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { NpmCopy, type RegistrySettings } from './cache.ts';
import { publishBody, smallBody } from './body.ts';
import { ANONYMOUS, audit, canPublish, registryIdentity, type Identity } from './keys.ts';
import {
  db,
  MAX_DOC,
  fail,
  fileOf,
  limiter,
  nameOf,
  now,
  packageByName,
  objectPath,
  sendFile,
  served,
  storeFile,
  tagOf,
  versionOf,
  versions,
  type Package,
  type Version,
} from './store.ts';
import { packageProject } from './projects.ts';

export function send(res: ServerResponse, value: unknown, status = 200) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'private, no-cache',
  });
  res.end(JSON.stringify(value));
}
function manifest(row: Version) {
  return {
    ...JSON.parse(row.manifest),
    ...(row.deprecated !== null ? { deprecated: row.deprecated } : {}),
  };
}
// pnpm holds back versions under a day old, and a registry can't exempt a name. Versions
// published here are the owner's own, so clients are told they're just past that default.
// A project that sets a longer wait keeps it, and Packages shows the real date from the database.
const PAST_DEFAULT_RELEASE_WAIT_MS = 25 * 60 * 60 * 1000;
const reportedTime = (row: Version) =>
  row.published_via === 'import'
    ? row.created_at
    : new Date(Date.parse(row.created_at) - PAST_DEFAULT_RELEASE_WAIT_MS).toISOString();
export function hostedDocument(pkg: Package, copy: NpmCopy) {
  const rows = versions(pkg.id);
  const tags = db()
    .prepare('SELECT tag,version FROM package_tags WHERE package_id=?')
    .all(pkg.id) as { tag: string; version: string }[];
  return {
    _id: pkg.name,
    name: pkg.name,
    'dist-tags': Object.fromEntries(tags.map((t) => [t.tag, t.version])),
    versions: Object.fromEntries(
      rows.map((row) => [
        row.version,
        {
          ...manifest(row),
          dist: {
            ...JSON.parse(row.manifest).dist,
            integrity: row.integrity,
            tarball: copy.tarballUrl(pkg.name, row.version),
          },
        },
      ]),
    ),
    time: Object.fromEntries(rows.map((row) => [row.version, reportedTime(row)])),
  };
}
export function abbreviated(doc: any) {
  return {
    name: doc.name,
    'dist-tags': doc['dist-tags'],
    versions: Object.fromEntries(
      Object.entries(doc.versions || {}).map(([version, value]: [string, any]) => [
        version,
        Object.fromEntries(
          [
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
          ]
            .filter((key) => value[key] !== undefined)
            .map((key) => [key, value[key]]),
        ),
      ]),
    ),
  };
}
export function deprecate(
  identity: Identity,
  pkg: Package,
  version: string,
  message: unknown,
  req?: IncomingMessage,
) {
  if (identity.pipeline) fail('Pipeline tokens can only publish new versions.', 403);
  canPublish(identity, pkg.created_by);
  if (typeof message !== 'string' || message.length > 4096)
    fail('A deprecation message is required');
  if (
    !db()
      .prepare('UPDATE package_versions SET deprecated=? WHERE package_id=? AND version=?')
      .run(message, pkg.id, version).changes
  )
    fail('Version not found', 404);
  audit(identity, 'deprecate', pkg.name + '@' + version, req);
}
export function createNpmRegistry(settings?: RegistrySettings) {
  const copy = new NpmCopy(settings);
  const busy = new Set<string>();
  async function publish(
    req: IncomingMessage,
    res: ServerResponse,
    name: string,
    identity: Identity,
  ) {
    canPublish(identity, packageByName(name)?.created_by);
    if (busy.has(name)) fail('A publish for this name is in progress. Try again.', 409);
    busy.add(name);
    let input: Awaited<ReturnType<typeof publishBody>> | undefined;
    try {
      const existing = packageByName(name);
      input = await publishBody(req);
      const doc = input.document;
      if (
        identity.pipeline &&
        (identity.pipeline.name !== name ||
          (existing && existing.project_id !== identity.pipeline.projectId))
      )
        fail('This pipeline token cannot publish this package.', 403);
      if (doc.name !== name || !doc.versions || typeof doc.versions !== 'object')
        fail('Package name does not match the publish URL', 422);
      const entries = Object.entries(doc.versions) as [string, any][];
      if (!input.attachment) {
        if (identity.pipeline) fail('Pipeline tokens can only publish new versions.', 403);
        if (!existing || !entries.length) fail('A tarball is required', 422);
        // npm deprecate PUTs the existing packument with only deprecated changed.
        const current = hostedDocument(existing, copy).versions;
        for (const [version, value] of entries) {
          const prior = current[version];
          if (!prior) fail('Version not found', 404);
          const { deprecated: _a, ...before } = prior;
          const { deprecated: _b, ...after } = value;
          if (!isDeepStrictEqual(before, after))
            fail(`${version} is already published. Nothing changed.`, 409);
          if (value.deprecated !== undefined && typeof value.deprecated !== 'string')
            fail('Only a changed deprecated field is accepted', 422);
        }
        db().transaction(() => {
          for (const [version, value] of entries)
            if (value.deprecated !== current[version].deprecated)
              deprecate(identity, existing, version, value.deprecated, req);
        })();
        return send(res, { ok: true });
      }
      if (entries.length !== 1) fail('Publish exactly one version', 422);
      const [version, value] = entries[0];
      versionOf(version);
      if (identity.pipeline && version !== identity.pipeline.version)
        fail('This pipeline token cannot publish this version.', 403);
      if (value.name !== name || value.version !== version)
        fail('Manifest name or version does not match', 422);
      if (existing && versions(existing.id).some((v) => v.version === version))
        fail(`${version} is already published. Nothing changed.`, 409);
      const tags = Object.entries(doc['dist-tags'] || { latest: version });
      for (const [tag, target] of tags) {
        tagOf(tag);
        if (target !== version) fail('Publish tags must point to the new version');
      }
      const claim = req.headers['x-deploy-package-claim'] === 'true';
      if (claim && !identity.admin) fail('Only an admin can claim a name from npmjs.org.', 403);
      let upstream: any;
      if (!existing && !name.startsWith('@deploy.local/')) {
        const prepared = await copy.document(name, true);
        const index = prepared ? await copy.index(prepared) : {};
        upstream = { versions: index };
        if (copy.failures)
          fail('Cannot check whether this name exists on npmjs.org while it is unreachable.', 503);
        if (Object.keys(index).length && !claim)
          fail(
            'This name exists on npmjs.org. An admin must use deploy packages publish --claim.',
            409,
          );
        if (prepared && claim && req.headers['x-deploy-package-import'] === 'true') {
          if (prepared.size > MAX_DOC) fail('Packument exceeds 10 MB.', 413);
          upstream = JSON.parse(await readFile(objectPath('docs', prepared.sha256), 'utf8'));
        }
      }
      if (upstream?.versions?.[version])
        fail(`${version} is already published. Nothing changed.`, 409);
      const attachment = input.attachment;
      if (value.dist?.shasum && value.dist.shasum !== attachment.shasum)
        fail('Tarball integrity check failed', 422);
      const file = await storeFile(
        createReadStream(attachment.path),
        'hosted',
        value.dist?.integrity || attachment.integrity,
      );
      const imported: {
        version: string;
        manifest: any;
        file: Awaited<ReturnType<typeof storeFile>>;
        createdAt: string;
      }[] = [];
      if (!existing && claim && req.headers['x-deploy-package-import'] === 'true') {
        for (const [oldVersion, oldManifest] of Object.entries(upstream?.versions || {}) as [
          string,
          any,
        ][]) {
          versionOf(oldVersion);
          imported.push({
            version: oldVersion,
            manifest: oldManifest,
            file: await copy.importVersion(name, oldVersion),
            createdAt: upstream.time?.[oldVersion] || now(),
          });
        }
      }
      const prior = existing
        ? (db()
            .prepare(
              'SELECT COALESCE(SUM(length(CAST(manifest AS BLOB))),0) AS bytes,COUNT(*) AS count FROM package_versions WHERE package_id=?',
            )
            .get(existing.id) as { bytes: number; count: number })
        : { bytes: 0, count: 0 };
      // Reserve room for rewritten dist URLs, timestamps and tags as well as manifests.
      const documentBytes =
        prior.bytes +
        Buffer.byteLength(JSON.stringify(value)) +
        imported.reduce((sum, old) => sum + Buffer.byteLength(JSON.stringify(old.manifest)), 0) +
        1024 * (prior.count + imported.length + 1);
      if (documentBytes > MAX_DOC) fail('Packument exceeds 10 MB.', 413);
      if (!registryIdentity(req))
        fail(`Run npm login --registry ${npmRegistryUrl(req, copy.settings.publicBase)}`, 401);
      const projectId =
        identity.pipeline?.projectId ?? (await packageProject(identity.username, value.repository));
      if (!registryIdentity(req)) fail('Pipeline credential expired or run ended.', 401);
      db().transaction(() => {
        // Unique constraints arbitrate concurrent writers/processes; no version is updated here.
        const pkg = packageByName(name);
        canPublish(identity, pkg?.created_by);
        if (identity.pipeline && pkg && pkg.project_id !== identity.pipeline.projectId)
          fail('This package belongs to another project.', 403);
        const id = pkg?.id || randomUUID();
        if (!pkg)
          db()
            .prepare(
              "INSERT INTO packages(id,ecosystem,name,project_id,created_by,created_at) VALUES(?,'npm',?,?,?,?)",
            )
            .run(id, name, projectId, identity.username, now());
        const insert = db().prepare(
          'INSERT INTO package_versions(package_id,version,sha256,integrity,size,manifest,published_by,published_via,"commit",deprecated,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        );
        for (const old of imported)
          insert.run(
            id,
            old.version,
            old.file.sha256,
            old.manifest.dist?.integrity || old.file.integrity,
            old.file.size,
            JSON.stringify(old.manifest),
            identity.username,
            'import',
            null,
            old.manifest.deprecated ?? null,
            old.createdAt,
          );
        insert.run(
          id,
          version,
          file.sha256,
          attachment.integrity,
          file.size,
          JSON.stringify({
            ...value,
            ...(identity.pipeline
              ? {
                  _deployPipeline: {
                    id: identity.pipeline.pipelineId,
                    pullNumber: identity.pipeline.pullNumber,
                  },
                }
              : {}),
            dist: { ...value.dist, shasum: attachment.shasum, integrity: attachment.integrity },
          }),
          identity.username,
          identity.pipeline ? 'release' : 'person',
          identity.pipeline?.commit ?? null,
          value.deprecated ?? null,
          now(),
        );
        for (const [tag, target] of tags)
          db()
            .prepare(
              'INSERT INTO package_tags VALUES(?,?,?) ON CONFLICT(package_id,tag) DO UPDATE SET version=excluded.version',
            )
            .run(id, tag, target);
      })();
      audit(identity, claim ? 'claim' : 'publish', name + '@' + version, req);
      return send(res, { ok: true, id: name }, 201);
    } finally {
      busy.delete(name);
      await input?.dispose();
    }
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const rawPath = (req.url || '').split('?')[0];
    if (!rawPath.startsWith('/npm/') && rawPath !== '/-/v1/search') return false;
    try {
      // Installing and starting browser sign-in need no key. Every package write still needs one.
      const read =
        req.method === 'GET' ||
        req.method === 'HEAD' ||
        (req.method === 'POST' &&
          (rawPath === '/npm/-/npm/v1/security/advisories/bulk' || rawPath === '/npm/-/v1/login'));
      const identity = registryIdentity(req) ?? (read ? ANONYMOUS : null);
      if (!identity) {
        res.setHeader('WWW-Authenticate', 'Basic realm="deploy.local Packages", charset="UTF-8"');
        send(
          res,
          {
            error: 'ENEEDAUTH',
            reason: `Run npm login --registry ${npmRegistryUrl(req, copy.settings.publicBase)}`,
          },
          401,
        );
        return true;
      }
      if (
        identity.pipeline &&
        (req.method !== 'PUT' || decodeURIComponent(rawPath) !== '/npm/' + identity.pipeline.name)
      )
        fail('Pipeline tokens can only publish their assigned package version.', 403);
      // Decode once. Never normalize dot segments before validating a registry path.
      let path: string;
      try {
        path = decodeURIComponent(
          rawPath.startsWith('/npm/') ? rawPath.slice(5) : rawPath.slice(1),
        );
      } catch {
        fail('Invalid package URL');
      }
      if (
        path.includes('\\') ||
        path.includes('\0') ||
        path.includes('%') ||
        path.split('/').some((v) => v === '.' || v === '..')
      )
        fail('Invalid package URL');
      if (path === '-/v1/login' && req.method === 'POST') {
        await smallBody(req);
        sendJson(res, startNpmLogin(req, npmRegistryUrl(req, copy.settings.publicBase)));
        return true;
      }
      const done = path.match(/^-\/v1\/login\/done\/([A-Za-z0-9_-]{43})$/);
      if (done && req.method === 'GET') {
        const result = pollNpmLogin(done[1]);
        if (!result) res.setHeader('Retry-After', '1');
        sendJson(res, result ?? { pending: true }, result ? 200 : 202);
        return true;
      }
      if (path === '-/whoami' && req.method === 'GET') {
        if (identity === ANONYMOUS) {
          res.setHeader('WWW-Authenticate', 'Basic realm="deploy.local Packages", charset="UTF-8"');
          send(
            res,
            {
              error: 'ENEEDAUTH',
              reason: `Run npm login --registry ${npmRegistryUrl(req, copy.settings.publicBase)}`,
            },
            401,
          );
          return true;
        }
        send(res, { username: identity.username });
        return true;
      }
      if (path === '-/ping' && req.method === 'GET') {
        send(res, {});
        return true;
      }
      if (path.startsWith('-/user/')) {
        send(
          res,
          { error: `Run npm login --registry ${npmRegistryUrl(req, copy.settings.publicBase)}` },
          403,
        );
        return true;
      }
      if (path === '-/npm/v1/security/advisories/bulk' && req.method === 'POST') {
        const body = await smallBody(req);
        try {
          const response = await copy.fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!response.ok) throw new Error('Audit unavailable');
          res.writeHead(response.status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          await pipeline(copy.body(response), res);
        } catch {
          if (res.headersSent) {
            res.destroy();
            return true;
          }
          res.setHeader('Warning', '199 deploy.local "npmjs.org audit unavailable"');
          send(res, {});
        }
        return true;
      }
      if (path === '-/v1/search' && req.method === 'GET') {
        const query = new URL(req.url!, 'http://localhost').searchParams.get('text') || '';
        const rows = (
          db()
            .prepare("SELECT * FROM packages WHERE ecosystem='npm' ORDER BY name")
            .all() as Package[]
        ).filter((p) => p.name.includes(query));
        send(res, {
          objects: rows.map((p) => ({
            package: { name: p.name, version: versions(p.id)[0]?.version },
            score: { final: 1, detail: { quality: 1, popularity: 0, maintenance: 1 } },
            searchScore: 1,
          })),
          total: rows.length,
          time: now(),
        });
        return true;
      }
      // pnpm's supply-chain checks read these. A hosted or private name has none, and with the
      // source down there is nothing to say, so both answer as "no attestations".
      const attestation = path.match(/^-\/npm\/v1\/attestations\/(.+)@([^@/]+)$/);
      if (attestation && req.method === 'GET') {
        const name = nameOf(attestation[1]);
        versionOf(attestation[2]);
        if (packageByName(name) || name.startsWith('@deploy.local/') || !copy.reachable)
          fail('Not found', 404);
        let response: Response;
        try {
          response = await copy.fetch(`-/npm/v1/attestations/${name}@${attestation[2]}`);
        } catch {
          fail('Not found', 404);
        }
        if (!response.ok) {
          await response.body?.cancel();
          fail('Not found', 404);
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        await pipeline(copy.body(response), limiter(MAX_DOC), res);
        return true;
      }
      const tagRoute = path.match(/^-\/package\/(.+)\/dist-tags(?:\/([^/]+))?$/);
      if (tagRoute) {
        const name = nameOf(tagRoute[1]),
          pkg = packageByName(name);
        if (!pkg) fail('Package not found', 404);
        if (req.method === 'GET') {
          send(res, hostedDocument(pkg, copy)['dist-tags']);
          return true;
        }
        canPublish(identity, pkg.created_by);
        const tag = tagOf(tagRoute[2] || '');
        if (req.method === 'PUT') {
          const version = await smallBody(req);
          if (typeof version !== 'string' || !versions(pkg.id).some((v) => v.version === version))
            fail('Version not found', 404);
          db()
            .prepare(
              'INSERT INTO package_tags VALUES(?,?,?) ON CONFLICT(package_id,tag) DO UPDATE SET version=excluded.version',
            )
            .run(pkg.id, tag, version);
        } else if (req.method === 'DELETE')
          db().prepare('DELETE FROM package_tags WHERE package_id=? AND tag=?').run(pkg.id, tag);
        else fail('Method not allowed', 405);
        audit(identity, 'tag', name + ':' + tag, req);
        send(res, { ok: true });
        return true;
      }
      if (req.method === 'DELETE') {
        canPublish(identity);
        fail('Versions are never removed. Deprecate it instead.', 403);
      }
      const tar = path.match(/^(.+)\/-\/([^/]+)$/);
      const name = nameOf(tar ? tar[1] : path),
        pkg = packageByName(name);
      if (req.method === 'GET' && tar) {
        const filename = fileOf(tar[2]);
        if (pkg) {
          const row = versions(pkg.id).find(
            (v) => filename === name.split('/').pop()! + '-' + v.version + '.tgz',
          );
          if (!row) fail('Version not found', 404);
          await sendFile(req, res, 'hosted', row);
        } else {
          const file = await copy.openTarball(name, filename);
          if (identity.computer)
            pinComputerInstall(
              identity.username,
              identity.credential.slice('computer:'.length),
              file.key,
            );
          try {
            await sendFile(req, res, 'cache', file, 'application/octet-stream', file.handle);
          } finally {
            await file.handle.close();
          }
        }
        served();
        return true;
      }
      if (req.method === 'GET') {
        const abridged = req.headers.accept?.includes('application/vnd.npm.install-v1+json');
        if (pkg) {
          const document = hostedDocument(pkg, copy);
          send(res, abridged ? abbreviated(document) : document);
        } else {
          const file = await copy.openDocument(name, abridged);
          try {
            await sendFile(req, res, 'docs', file, 'application/json', file.handle);
          } finally {
            await file.handle.close();
          }
        }
        served();
        return true;
      }
      if (req.method === 'PUT' && !tar) {
        await publish(req, res, name, identity);
        return true;
      }
      fail('Method not allowed', 405);
    } catch (error: any) {
      if (
        res.destroyed &&
        ['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET', 'EPIPE'].includes(error.code)
      )
        return true;
      if (!error.status) {
        // Error messages may contain credentials or request bodies. Log only the
        // exception class and source locations, never arbitrary error text.
        console.error('Unexpected package registry error', {
          type: error instanceof TypeError ? 'TypeError' : 'Error',
          code: typeof error?.code === 'string' ? error.code : undefined,
          locations:
            error instanceof Error
              ? error.stack
                  ?.split('\n')
                  .filter((line) => /^\s+at /.test(line))
                  .flatMap((line) => line.match(/file:\/\/\/[^\s()]+:\d+:\d+/g) || [])
              : [],
        });
      }
      if (!res.headersSent && error.status === 413) res.setHeader('Connection', 'close');
      if (res.headersSent) res.destroy();
      else
        send(
          res,
          {
            error: error.status ? error.message : 'Internal package registry error',
            code: error.status === 409 ? 'EPUBLISHCONFLICT' : 'E' + (error.status || 500),
            reason: error.status ? error.message : 'Internal package registry error',
          },
          error.status || 500,
        );
      return true;
    }
  }
  return { handle, copy };
}
export const npmRegistry = createNpmRegistry();
