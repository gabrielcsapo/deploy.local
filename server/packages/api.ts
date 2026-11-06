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
export async function packagesApi(
  req: IncomingMessage,
  res: ServerResponse,
  username: string,
  copy = npmRegistry.copy,
) {
  const path = new URL(req.url!, 'http://localhost').pathname;
  if (!/^\/api\/v2\/(?:packages|package-keys)(?:\/|$)/.test(path)) return false;
  const identity: Identity = {
    username,
    publish: true,
    admin: isAdmin(username),
    credential: 'person-session',
  };
  if (path === '/api/v2/packages/cache' && req.method === 'GET') {
    send(res, copiesStatus(username, copy));
    return true;
  }
  if (path === '/api/v2/packages/cache/warm' && req.method === 'POST') {
    const body = await smallBody(req);
    const projects = list('project', username).filter(
      (p) => !body.projectId || p.id === body.projectId,
    );
    if (body.projectId && !projects.length) fail('Project not found', 404);
    for (const project of projects) queueCopies(username, project.id);
    send(res, { queued: projects.length }, 202);
    return true;
  }
  if (path === '/api/v2/package-keys') {
    if (req.method === 'GET') send(res, { keys: listKeys(username) });
    else if (req.method === 'POST') {
      const body = await smallBody(req);
      const key = createKey(username, body.label, body.scope);
      audit(identity, 'key-created', key.id, req);
      send(res, key, 201);
    } else if (req.method === 'DELETE') {
      const body = await smallBody(req);
      db()
        .prepare('DELETE FROM package_keys WHERE username=? AND id=?')
        .run(username, String(body.id));
      audit(identity, 'key-removed', String(body.id), req);
      send(res, { ok: true });
    } else fail('Method not allowed', 405);
    return true;
  }
  if (path === '/api/v2/packages' && req.method === 'GET') {
    if (new URL(req.url!, 'http://localhost').searchParams.has('sidebar')) {
      send(res, {
        served: !!db().prepare("SELECT 1 FROM system_settings WHERE key='packages.served'").get(),
        usingCopies: !copy.reachable,
      });
      return true;
    }
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
    send(res, {
      packages,
      served: !!db().prepare("SELECT 1 FROM system_settings WHERE key='packages.served'").get(),
      usingCopies: !copy.reachable,
    });
    return true;
  }
  const match = path.match(/^\/api\/v2\/packages\/npm\/(.+?)(?:\/versions\/([^/]+)\/deprecate)?$/);
  if (!match) fail('Not found', 404);
  const name = nameOf(decodeURIComponent(match[1])),
    pkg = packageByName(name);
  if (!pkg) fail('Package not found', 404);
  if (req.method === 'POST' && match[2]) {
    const body = await smallBody(req);
    deprecate(identity, pkg, decodeURIComponent(match[2]), body.message, req);
    send(res, { ok: true });
    return true;
  }
  if (req.method !== 'GET' || match[2]) fail('Method not allowed', 405);
  const rows = versions(pkg.id);
  const tags = db().prepare('SELECT tag,version FROM package_tags WHERE package_id=?').all(pkg.id);
  const project = list('project', username).find((p) => p.id === pkg.project_id);
  send(res, {
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
      createdAt: v.created_at,
    })),
    tags,
    usedBy: await usedBy(username, name),
    canPublish: identity.admin || pkg.created_by === username,
  });
  return true;
}
