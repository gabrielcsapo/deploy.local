/**
 * Edge runtime bootstrap, shared by both topologies:
 *  - the dedicated edge process (server/edge/index.ts)
 *  - single-process mode (server.ts / server/index.ts), where the "edge"
 *    modules run in the same process wired through the in-process IPC shim.
 *
 * Owns: the route table, mDNS registration for dashboard + app hosts, TCP
 * proxies, the TCP-proxy logging hooks, and the EdgeHandlers consumed by
 * either the IPC server (split mode) or createLocalLink (single mode).
 */

import { resolve } from 'node:path';
import { RouteTable } from './routes.ts';
import { registerHost } from '../mdns.ts';
import { setTcpProxyHooks, stopAllProxies } from '../tcp-proxy.ts';
import type { EdgeHandlers } from '../ipc.ts';
import type { HotPathDeps, RequestLogEntry } from './proxy.ts';

export interface EdgeRuntimeOptions {
  dbFile: string;
  /** Buffered request-log write (edge's own writer or store's re-export). */
  logRequest: (name: string, entry: RequestLogEntry) => void;
  /** Event fan-out (events.ts emit in single mode, IPC forward in split mode). */
  emitEvent: HotPathDeps['emitEvent'];
  /** Called on cert:reload — the entry owning the TLS server reloads its context. */
  onCertReload?: () => void;
}

export interface EdgeRuntime {
  routes: RouteTable;
  handlers: EdgeHandlers;
  hotPathDeps: HotPathDeps;
  close(): void;
}

export function getDefaultDbFile(): string {
  const dataDir = process.env.DEPLOY_DATA_DIR || resolve(process.cwd(), '.deploy-data');
  return resolve(dataDir, 'deploy.db');
}

export function initEdgeRuntime(opts: EdgeRuntimeOptions): EdgeRuntime {
  setTcpProxyHooks({
    logRequest: (name, entry) => opts.logRequest(name, entry as unknown as RequestLogEntry),
    emit: opts.emitEvent,
  });

  const routes = new RouteTable(opts.dbFile);

  // Dashboard hosts first so deploy.local resolves even with zero apps.
  registerHost('deploy');
  registerHost('discover');
  routes.reloadAll();

  const handlers: EdgeHandlers = {
    onRouteChanged: (name) => routes.reconcile(name),
    onCertReload: () => opts.onCertReload?.(),
    onControlConnected: () => {
      // Resync everything a dropped link may have missed.
      routes.reloadAll();
      opts.onCertReload?.();
    },
  };

  const hotPathDeps: HotPathDeps = {
    getRoute: (appName) => routes.getRoute(appName),
    logRequest: opts.logRequest,
    emitEvent: opts.emitEvent,
  };

  return {
    routes,
    handlers,
    hotPathDeps,
    close() {
      stopAllProxies();
      routes.close();
    },
  };
}
