import { copiesStatus, queueCopies } from './copies.ts';
import { npmRegistry } from './npm.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAdmin } from '../store.ts';
import { list } from '../workspace/store.ts';
import { createKey, listKeys, audit, type Identity } from './keys.ts';
import { smallBody } from './body.ts';
import { db, fail, nameOf, packageByName, versions, type Package } from './store.ts';
import { deprecate, send } from './npm.ts';
import { usedBy } from './projects.ts';
import { dispatch, routes } from '../routes.ts';

interface PackagesContext {
  username: string;
  readonly identity: Identity;
  copy: typeof npmRegistry.copy;
}

const route = routes<PackagesContext>();

function served() {
  return !!db().prepare("SELECT 1 FROM system_settings WHERE key='packages.served'").get();
}

/** Sidebar status never inspects a repository or probes the registry. */
export function packageSidebar(copy = npmRegistry.copy) {
  return { served: served(), usingCopies: !copy.reachable };
}

/** The package a `/api/v2/packages/npm/<name>` path names, or 404. */
function packageAt(encoded: string) {
  const name = nameOf(decodeURIComponent(encoded)),
    pkg = packageByName(name);
  if (!pkg) fail('Package not found', 404);
  return { name, pkg };
}

export const packagesRoutes = [
  route({
    method: 'GET',
    path: '/api/v2/packages/cache',
    handler: ({ res, context }) => send(res, copiesStatus(context.username, context.copy)),
  }),
  route({
    method: 'POST',
    path: '/api/v2/packages/cache/warm',
    input: smallBody,
    handler: ({ res, input: body, context }) => {
      const projects = list('project', context.username).filter(
        (p) => !body.projectId || p.id === body.projectId,
      );
      if (body.projectId && !projects.length) fail('Project not found', 404);
      for (const project of projects) queueCopies(context.username, project.id);
      send(res, { queued: projects.length }, 202);
    },
  }),
  route({
    method: 'GET',
    path: '/api/v2/package-keys',
    handler: ({ res, context }) => send(res, { keys: listKeys(context.username) }),
  }),
  route({
    method: 'POST',
    path: '/api/v2/package-keys',
    input: smallBody,
    handler: ({ req, res, input: body, context }) => {
      const key = createKey(context.username, body.label, body.scope);
      audit(context.identity, 'key-created', key.id, req);
      send(res, key, 201);
    },
  }),
  route({
    method: 'DELETE',
    path: '/api/v2/package-keys',
    input: smallBody,
    handler: ({ req, res, input: body, context }) => {
      db()
        .prepare('DELETE FROM package_keys WHERE username=? AND id=?')
        .run(context.username, String(body.id));
      audit(context.identity, 'key-removed', String(body.id), req);
      send(res, { ok: true });
    },
  }),
  route({
    method: '*',
    path: '/api/v2/package-keys',
    handler: () => fail('Method not allowed', 405),
  }),
  route({
    method: 'GET',
    path: '/api/v2/packages',
    handler: async ({ res, url, context }) => {
      const { username, copy } = context;
      if (url.searchParams.has('sidebar')) return send(res, packageSidebar(copy));
      return send(res, await readPackages(username, copy));
    },
  }),
  // The package is looked up before the method is checked, so a wrong method on a missing
  // package is still a 404, and the body is read only once the package exists.
  route({
    method: '*',
    path: '/api/v2/packages/npm/:name*/versions/:version/deprecate',
    handler: async ({ req, res, params, context }) => {
      const { pkg } = packageAt(params.name);
      if (req.method !== 'POST') fail('Method not allowed', 405);
      const body = await smallBody(req);
      deprecate(context.identity, pkg, decodeURIComponent(params.version), body.message, req);
      send(res, { ok: true });
    },
  }),
  route({
    method: '*',
    path: '/api/v2/packages/npm/:name*',
    handler: async ({ req, res, params, context }) => {
      packageAt(params.name);
      if (req.method !== 'GET') fail('Method not allowed', 405);
      return send(res, await readPackage(context.username, params.name, context.identity.admin));
    },
  }),
];

const packagesDispatch = dispatch(packagesRoutes, {
  scope: /^\/api\/v2\/(?:packages|package-keys)(?:\/|$)/,
  notFound: () => fail('Not found', 404),
});

export async function packagesApi(
  req: IncomingMessage,
  res: ServerResponse,
  username: string,
  copy = npmRegistry.copy,
) {
  let identity: Identity | undefined;
  return packagesDispatch(req, res, {
    username,
    copy,
    get identity() {
      return (identity ??= {
        username,
        publish: true,
        admin: isAdmin(username),
        credential: 'person-session',
      });
    },
  });
}

export async function readPackages(username: string, copy = npmRegistry.copy) {
  const rows = db()
    .prepare("SELECT * FROM packages WHERE ecosystem='npm' ORDER BY created_at,name")
    .all() as Package[];
  const projects = list('project', username);
  const packages = [];
  for (const pkg of rows) {
    const latest = versions(pkg.id)[0];
    packages.push({
      ...pkg,
      latest: latest
        ? {
            version: latest.version,
            publishedBy: latest.published_by,
            publishedByYou: latest.published_by === username,
            publishedVia: latest.published_via,
            createdAt: latest.created_at,
          }
        : null,
      project: projects.find((p) => p.id === pkg.project_id)?.name || null,
      usedBy: (await usedBy(username, pkg.name)).length,
    });
  }
  return { packages, served: served(), usingCopies: !copy.reachable };
}

export async function readPackage(username: string, encoded: string, admin = isAdmin(username)) {
  const { name, pkg } = packageAt(encoded);
  const rows = versions(pkg.id);
  const tags = db().prepare('SELECT tag,version FROM package_tags WHERE package_id=?').all(pkg.id);
  const project = list('project', username).find((p) => p.id === pkg.project_id);
  return {
    package: pkg,
    project: project ? { id: project.id, name: project.name } : null,
    directory: rows[0] ? JSON.parse(rows[0].manifest).repository?.directory || null : null,
    versions: rows.map((v) => ({
      version: v.version,
      size: v.size,
      deprecated: v.deprecated,
      publishedBy: v.published_by,
      publishedByYou: v.published_by === username,
      publishedVia: v.published_via,
      commit: v.commit,
      pipeline:
        v.published_via === 'release' ? JSON.parse(v.manifest)._deployPipeline || null : null,
      createdAt: v.created_at,
    })),
    tags,
    usedBy: await usedBy(username, name),
    canPublish: admin || pkg.created_by === username,
  };
}
