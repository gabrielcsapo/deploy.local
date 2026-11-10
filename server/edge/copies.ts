import { openDatabase, type Database } from '../sqlite.ts';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { registerHost, unregisterHost } from '../mdns.ts';

export function copyHostname(id: string, app: string) {
  if (!/^[a-z0-9-]{1,58}$/.test(id) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(app))
    throw new Error('Invalid copy address');
  return `copy-${id}.${app}.deploy.local`;
}
export const isCopyHost = (host: string) =>
  host.toLowerCase().startsWith('copy-') && host.toLowerCase().endsWith('.deploy.local');
type Identity = { username: string; token: string };
type Grant = Identity & { host: string; expires: number; path: string };
type CopyRoute = { owner: string; port: number };
const cookieName = '__Host-deploy-copy';
function cookies(req: IncomingMessage) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';').map((part) => {
      const index = part.indexOf('=');
      return [part.slice(0, index).trim(), part.slice(index + 1)];
    }),
  );
}
function identity(req: IncomingMessage): Identity | undefined {
  const username = req.headers['x-deploy-username'];
  const token = req.headers['x-deploy-token'];
  if (typeof username === 'string' && typeof token === 'string') return { username, token };
  try {
    const value = decodeURIComponent(cookies(req)['deploy-sh-auth'] || '');
    const index = value.indexOf(':');
    if (index > 0) return { username: value.slice(0, index), token: value.slice(index + 1) };
  } catch {
    /* Invalid cookies are unauthenticated. */
  }
}

/** Read-only edge authorization. No coordinator schema initialization or cached access decisions. */
export class CopyPreviews {
  private main: Database;
  private workspace?: Database;
  private workspaceFile: string;
  private grants = new Map<string, Grant>();
  private tickets = new Map<string, Grant>();
  private hosts = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(dbFile: string, advertise = true) {
    this.main = openDatabase(dbFile, { readonly: true, fileMustExist: true });
    this.workspaceFile = join(dirname(dbFile), 'workspace', 'workspace.db');
    if (advertise) {
      this.refreshHosts();
      this.timer = setInterval(() => this.refreshHosts(), 2000);
      this.timer.unref();
    }
  }
  private records() {
    if (!this.workspace && existsSync(this.workspaceFile))
      this.workspace = openDatabase(this.workspaceFile, { readonly: true, fileMustExist: true });
    return (this.workspace
      ?.prepare("SELECT owner,data FROM records WHERE kind='v2-backup-restore'")
      .all() || []) as { owner: string; data: string }[];
  }
  private routes() {
    const routes = new Map<string, CopyRoute>();
    for (const row of this.records()) {
      const restore = JSON.parse(row.data);
      if (restore.state !== 'ready') continue;
      for (const copy of restore.copies || []) {
        if (!Number.isInteger(copy.port) || copy.port < 1 || copy.port > 65535) continue;
        routes.set(copyHostname(restore.id, copy.app), { owner: row.owner, port: copy.port });
      }
    }
    return routes;
  }
  private refreshHosts() {
    try {
      const hosts = new Set(this.routes().keys());
      for (const host of hosts) if (!this.hosts.has(host)) registerHost(host.slice(0, -6));
      for (const host of this.hosts) if (!hosts.has(host)) unregisterHost(host.slice(0, -6));
      this.hosts = hosts;
    } catch {
      /* Fail closed while the coordinator initializes the workspace database. */
    }
  }
  private authorized(auth: Identity | undefined, owner: string) {
    if (!auth || auth.username !== owner) return false;
    return !!this.main
      .prepare(
        'SELECT 1 FROM sessions WHERE username=? AND token=? AND (expires_at IS NULL OR expires_at>?)',
      )
      .get(owner, auth.token, Date.now());
  }
  handle = (req: IncomingMessage, res: ServerResponse): boolean => {
    const host = (req.headers.host || String(req.headers[':authority'] || ''))
      .split(':')[0]
      .toLowerCase();
    const url = new URL(req.url || '/', 'https://deploy.local');
    const bridge = host === 'deploy.local' && url.pathname === '/_copy/open';
    if (!bridge && !isCopyHost(host)) return false;
    const finish = (status: number, text: string, headers = {}) => {
      res.writeHead(status, {
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Type': 'text/plain; charset=utf-8',
        ...headers,
      });
      res.end(text);
      return true;
    };
    for (const map of [this.grants, this.tickets])
      for (const [key, grant] of map) if (grant.expires <= Date.now()) map.delete(key);
    try {
      const target = bridge ? url.searchParams.get('host') || '' : host;
      const route = this.routes().get(target);
      if (!route) return finish(404, 'This copy is no longer available.');
      if (
        req.headers['x-deploy-agent-token'] ||
        req.headers['x-deploy-worker-token'] ||
        req.headers['x-deploy-node-secret']
      )
        return finish(403, 'Sign in as the owner to open this copy.');
      if (bridge) {
        if (req.method !== 'GET') return finish(405, 'Method not allowed');
        const auth = identity(req);
        if (!this.authorized(auth, route.owner))
          return finish(401, 'Sign in at deploy.local as the owner, then open the copy again.');
        if (this.tickets.size >= 1000) return finish(429, 'Try again shortly.');
        const ticket = randomBytes(32).toString('hex');
        const path = url.searchParams.get('path') || '/';
        this.tickets.set(ticket, {
          ...auth!,
          host: target,
          expires: Date.now() + 30_000,
          path:
            path.startsWith('/') && !path.startsWith('//') && !/[\\\r\n]/.test(path) ? path : '/',
        });
        return finish(303, '', { Location: `https://${target}/_copy/auth?ticket=${ticket}` });
      }
      if (url.pathname === '/_copy/auth') {
        const ticket = url.searchParams.get('ticket') || '';
        const grant = this.tickets.get(ticket);
        this.tickets.delete(ticket);
        if (!grant || grant.host !== host || !this.authorized(grant, route.owner))
          return finish(403, 'Copy access expired. Open the copy again from Backups.');
        if (this.grants.size >= 1000) return finish(429, 'Try again shortly.');
        const key = randomBytes(32).toString('hex');
        this.grants.set(key, { ...grant, expires: Date.now() + 3600_000 });
        return finish(303, '', {
          Location: grant.path,
          'Set-Cookie': `${cookieName}=${key}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600`,
        });
      }
      const grant = this.grants.get(cookies(req)[cookieName]);
      const auth = grant?.host === host ? grant : identity(req);
      if (!this.authorized(auth, route.owner)) {
        if (req.method === 'GET' && !req.headers['x-deploy-token'])
          return finish(303, '', {
            Location: `https://deploy.local/_copy/open?host=${encodeURIComponent(host)}&path=${encodeURIComponent(req.url || '/')}`,
          });
        return finish(403, 'Sign in as the owner to open this copy.');
      }
      const headers = { ...req.headers };
      for (const key of Object.keys(headers))
        if (
          key.startsWith(':') ||
          key.startsWith('x-deploy-') ||
          ['authorization', 'connection', 'upgrade'].includes(key)
        )
          delete headers[key];
      headers.cookie = (headers.cookie || '')
        .split(';')
        .filter((part) => ![cookieName, 'deploy-sh-auth'].includes(part.trim().split('=')[0]))
        .join(';');
      const upstream = request(
        { hostname: '127.0.0.1', port: route.port, path: req.url, method: req.method, headers },
        (response) => {
          const outgoing = {
            ...response.headers,
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
          };
          // App cookies stay on this copy host and cannot overwrite coordinator access.
          outgoing['set-cookie'] = response.headers['set-cookie']
            ?.filter(
              (value) => ![cookieName, 'deploy-sh-auth'].includes(value.split('=')[0].trim()),
            )
            .map((value) => value.replace(/;\s*Domain=[^;]*/gi, ''));
          if (!outgoing['set-cookie']?.length) delete outgoing['set-cookie'];
          delete outgoing.connection;
          delete outgoing['transfer-encoding'];
          res.writeHead(response.statusCode || 502, outgoing);
          response.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) finish(502, 'The copy is unavailable.');
        else res.destroy();
      });
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
      return true;
    } catch {
      return finish(503, 'Copy access is temporarily unavailable.');
    }
  };
  close() {
    clearInterval(this.timer);
    for (const host of this.hosts) unregisterHost(host.slice(0, -6));
    this.workspace?.close();
    this.main.close();
  }
}
