import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { NpmCopy, type RegistrySettings } from './cache.ts';
import { publishBody, smallBody } from './body.ts';
import { audit, canPublish, registryIdentity, type Identity } from './keys.ts';
import {
  db,
  MAX_DOC,
  fail,
  fileOf,
  nameOf,
  now,
  packageByName,
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
    time: Object.fromEntries(rows.map((row) => [row.version, row.created_at])),
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
      if (doc.name !== name || !doc.versions || typeof doc.versions !== 'object')
        fail('Package name does not match the publish URL', 422);
      const entries = Object.entries(doc.versions) as [string, any][];
      if (!input.attachment) {
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
      if (!existing) {
        upstream = await copy.document(name, true);
        if (!copy.reachable)
          fail('Cannot check whether this name exists on npmjs.org while it is unreachable.', 503);
        if (upstream && !upstream._removed && Object.keys(upstream.versions).length && !claim)
          fail(
            'This name exists on npmjs.org. An admin must use deploy packages publish --claim.',
            409,
          );
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
      if (!registryIdentity(req)) fail('Run deploy packages login.', 401);
      const projectId = await packageProject(identity.username, value.repository);
      db().transaction(() => {
        // Unique constraints arbitrate concurrent writers/processes; no version is updated here.
        const pkg = packageByName(name);
        canPublish(identity, pkg?.created_by);
        const id = pkg?.id || randomUUID();
        if (!pkg)
          db()
            .prepare(
              "INSERT INTO packages(id,ecosystem,name,project_id,created_by,created_at) VALUES(?,'npm',?,?,?,?)",
            )
            .run(id, name, projectId, identity.username, now());
        const insert = db().prepare(
          'INSERT INTO package_versions(package_id,version,sha256,integrity,size,manifest,published_by,published_via,deprecated,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
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
            dist: { ...value.dist, shasum: attachment.shasum, integrity: attachment.integrity },
          }),
          identity.username,
          'person',
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
      const identity = registryIdentity(req);
      if (!identity) {
        res.setHeader('WWW-Authenticate', 'Basic realm="deploy.local Packages", charset="UTF-8"');
        send(res, { error: 'ENEEDAUTH', reason: 'Run deploy packages login.' }, 401);
        return true;
      }
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
      if (path === '-/whoami' && req.method === 'GET') {
        send(res, { username: identity.username });
        return true;
      }
      if (path === '-/ping' && req.method === 'GET') {
        send(res, {});
        return true;
      }
      if (path.startsWith('-/user/')) {
        send(res, { error: 'Run deploy packages login.' }, 403);
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
          await pipeline(Readable.fromWeb(response.body as any), res);
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
        } else await sendFile(req, res, 'cache', await copy.tarball(name, filename));
        served();
        return true;
      }
      if (req.method === 'GET') {
        const document = pkg ? hostedDocument(pkg, copy) : await copy.document(name);
        if (!document || document._removed) fail('Package not found', 404);
        const rewritten = pkg ? document : copy.rewritten(document);
        const abridged = req.headers.accept?.includes('application/vnd.npm.install-v1+json');
        send(res, abridged ? abbreviated(rewritten) : rewritten);
        served();
        return true;
      }
      if (req.method === 'PUT' && !tar) {
        await publish(req, res, name, identity);
        return true;
      }
      fail('Method not allowed', 405);
    } catch (error: any) {
      if (!res.headersSent && error.status === 413) res.setHeader('Connection', 'close');
      if (res.headersSent) res.destroy();
      else
        send(
          res,
          {
            error: error.status ? error.message : 'Invalid package request',
            code: error.status === 409 ? 'EPUBLISHCONFLICT' : 'E' + (error.status || 400),
            reason: error.status ? error.message : 'Invalid package request',
          },
          error.status || 400,
        );
      return true;
    }
  }
  return { handle, copy };
}
export const npmRegistry = createNpmRegistry();
