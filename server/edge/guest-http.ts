import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { isIP } from 'node:net';
import { appNameFromHost } from './app-pages.ts';
import { isCopyHost } from './copies.ts';

import { tunnelAppUpgrade, type UpgradeProxyDeps } from './upgrade-proxy.ts';

type SharedApps = { isShared(name: string): boolean };

function hostname(req: IncomingMessage) {
  // Preserve brackets around IPv6 authorities when replacing the port for HTTPS.
  return (req.headers.host || 'deploy.local').replace(/:\d+$/, '').toLowerCase();
}

export function guestHttpTarget(req: IncomingMessage, apps: SharedApps) {
  const host = hostname(req).replace(/\.$/, '');
  const app = appNameFromHost(host);
  if (isCopyHost(host)) return 'https';
  if (app) return apps.isShared(app) ? 'app' : 'https';

  const path = (req.url || '/').split('?')[0];
  const read = req.method === 'GET' || req.method === 'HEAD';
  const coordinator =
    host === 'deploy.local' || host === 'localhost' || isIP(host.replace(/^\[|\]$/g, ''));
  if (coordinator && read && (path === '/' || isHomeAsset(path))) return 'home';

  // Native fetch clients also send Sec-Fetch-Mode: cors. Browsers supply the site or Origin.
  if (
    path.startsWith('/api/') &&
    path !== '/api/apps-home' &&
    (req.headers.origin || req.headers['sec-fetch-site'])
  )
    return 'https';
  return 'existing';
}

function isHomeAsset(path: string) {
  return (
    /^\/(?:assets|fonts)\/(?:[\w@-][\w.@-]*\/)*[\w@-][\w.@-]*\.(?:js|css|woff2?|ttf|otf|svg|png|webp)$/.test(
      path,
    ) ||
    /^\/(?:favicon(?:-96x96\.png|\.ico|\.svg)|apple-touch-icon\.png|site\.webmanifest|web-app-manifest-(?:192x192|512x512)\.png)$/.test(
      path,
    )
  );
}

export function redirectToHttps(req: IncomingMessage, res: ServerResponse, port: number) {
  const authority = hostname(req) + (port === 443 ? '' : `:${port}`);
  // A private app can become shared later; a cached permanent redirect would hide that change.
  res.writeHead(307, {
    Location: `https://${authority}${req.url || '/'}`,
    'Cache-Control': 'no-store',
  });
  res.end();
}

export function attachPlainHttpUpgrades(
  server: Server,
  apps: SharedApps & UpgradeProxyDeps,
  upgradeControl: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
) {
  server.on('upgrade', (req, socket, head) => {
    const target = guestHttpTarget(req, apps);
    if (target === 'app') {
      const name = appNameFromHost(hostname(req))!;
      tunnelAppUpgrade(req, socket, head, apps.getRoute(name));
    } else if (target === 'existing' && !req.headers.origin) {
      upgradeControl(req, socket, head);
    } else {
      socket.destroy();
    }
  });
}
