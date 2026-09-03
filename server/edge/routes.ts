/**
 * Edge route table: app name → backend port, plus the side-effects that hang
 * off a deployment row (mDNS registration, TCP proxies for extra ports).
 *
 * The DB is the source of truth; IPC `route:changed` messages are hints that
 * a row changed. The table opens its own READ-ONLY better-sqlite3 connection
 * (raw SQL, never drizzle/migrations — those belong to the control plane) and
 * mirrors rows into an in-memory Map for O(1) hot-path lookups.
 */

import Database from 'better-sqlite3';
import type { IncomingMessage } from 'node:http';
import { registerHost, unregisterHost } from '../mdns.ts';
import { startProxies, stopProxies, type ExtraPortMapping } from '../tcp-proxy.ts';
import { readDeployConfig, type DeployConfig } from '../deploy-config.ts';
import { purgeDeploymentCache } from './response-cache.ts';
import { ServiceEndpointPool, selectServiceBackend } from '../service-routing.ts';

export interface EdgeRoute {
  name: string;
  port: number | null;
  backendHost: string;
  /** JSON string of ExtraPortMapping[] as stored on the row. */
  extraPorts: string | null;
  cache?: DeployConfig['cache'];
  /** Active published graph service. When set, requests lease a ready endpoint. */
  serviceId?: string;
  selectBackend?: (req: IncomingMessage) => {
    host: string;
    port: number;
    endpointId: string;
    release(): void;
  } | null;
}

interface DeploymentRow {
  name: string;
  port: number | null;
  extra_ports: string | null;
  directory: string | null;
  backend_host: string | null;
  app_id: string | null;
}

interface GraphEndpointRow {
  service_id: string;
  endpoint_id: string;
  instance_id: string;
  host: string;
  port: number;
  release_digest: string;
  readiness: 'ready';
}

export class RouteTable {
  private sqlite: InstanceType<typeof Database>;
  private cache = new Map<string, EdgeRoute>();
  private endpoints = new ServiceEndpointPool();
  private graphServiceByDeployment = new Map<string, string>();

  constructor(dbFile: string) {
    this.sqlite = new Database(dbFile, { readonly: true, fileMustExist: true });
    // WAL readers coexist with the control plane's writers; wait out
    // checkpoint locks instead of throwing SQLITE_BUSY.
    this.sqlite.pragma('busy_timeout = 5000');
  }

  getRoute(name: string): EdgeRoute | null {
    return this.cache.get(name) ?? null;
  }

  /** Full resync from the DB — boot, and after every IPC (re)connect. */
  reloadAll() {
    const rows = this.sqlite
      .prepare(
        `SELECT d.name, d.port, d.extra_ports, d.directory, d.app_id, n.address AS backend_host
         FROM deployments d
         LEFT JOIN nodes n ON n.id = d.active_node_id`,
      )
      .all() as DeploymentRow[];
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.name);
      this.apply(row);
    }
    for (const name of [...this.cache.keys()]) {
      if (!seen.has(name)) this.remove(name);
    }
    console.log(`[edge] route table loaded: ${this.cache.size} deployments`);
  }

  /** Re-read one row after a route:changed hint. Missing row ⇒ removal. */
  reconcile(name: string) {
    const row = this.sqlite
      .prepare(
        `SELECT d.name, d.port, d.extra_ports, d.directory, d.app_id, n.address AS backend_host
         FROM deployments d
         LEFT JOIN nodes n ON n.id = d.active_node_id
         WHERE d.name = ?`,
      )
      .get(name) as DeploymentRow | undefined;
    if (!row) {
      this.remove(name);
    } else {
      this.apply(row);
    }
  }

  private apply(row: DeploymentRow) {
    const prev = this.cache.get(row.name);
    const backendHost = row.backend_host || '127.0.0.1';
    if (prev && (prev.port !== row.port || prev.backendHost !== backendHost)) {
      purgeDeploymentCache(row.name);
    }
    let cache: DeployConfig['cache'];
    if (row.directory) {
      try {
        cache = readDeployConfig(row.directory).cache;
      } catch (err) {
        console.warn(`[edge] ${row.name}: ignoring invalid cache config:`, err);
      }
    }
    const graph = this.loadPublishedGraphEndpoints(row.app_id, row.port);
    const previousServiceId = this.graphServiceByDeployment.get(row.name);
    if (previousServiceId && previousServiceId !== graph?.serviceId) {
      this.endpoints.replace(previousServiceId, []);
      this.graphServiceByDeployment.delete(row.name);
    }
    if (graph) {
      this.endpoints.replace(graph.serviceId, graph.endpoints);
      this.graphServiceByDeployment.set(row.name, graph.serviceId);
    }
    this.cache.set(row.name, {
      name: row.name,
      port: row.port,
      backendHost,
      extraPorts: row.extra_ports,
      cache,
      serviceId: graph?.serviceId,
      selectBackend: graph
        ? () => selectServiceBackend(this.endpoints, graph.serviceId)
        : undefined,
    });

    // mDNS registration is idempotent (registerHost keeps a Set).
    registerHost(row.name);

    // Restart TCP proxies only when the extra-port set actually changed —
    // status-only row updates must not churn listening sockets.
    if (
      (row.extra_ports ?? null) !== (prev?.extraPorts ?? null) ||
      backendHost !== prev?.backendHost
    ) {
      if (row.extra_ports) {
        try {
          const ports = JSON.parse(row.extra_ports) as ExtraPortMapping[];
          if (ports.length > 0) {
            startProxies(row.name, ports, backendHost);
          } else {
            stopProxies(row.name);
          }
        } catch {
          console.error(`[edge] ${row.name}: invalid extraPorts JSON: ${row.extra_ports}`);
        }
      } else {
        stopProxies(row.name);
      }
    }
  }

  private remove(name: string) {
    purgeDeploymentCache(name);
    this.cache.delete(name);
    const serviceId = this.graphServiceByDeployment.get(name);
    if (serviceId) this.endpoints.replace(serviceId, []);
    this.graphServiceByDeployment.delete(name);
    unregisterHost(name);
    stopProxies(name);
  }

  close() {
    this.sqlite.close();
  }

  private loadPublishedGraphEndpoints(
    appId: string | null,
    primaryPort: number | null,
  ): {
    serviceId: string;
    endpoints: Array<{
      id: string;
      serviceId: string;
      instanceId: string;
      host: string;
      port: number;
      releaseDigest: string;
      readiness: 'ready';
    }>;
  } | null {
    if (!appId) return null;
    const rows = this.sqlite
      .prepare(
        `SELECT cs.id AS service_id, se.id AS endpoint_id, se.instance_id,
                se.host, se.port, se.release_digest, se.readiness
           FROM component_services cs
           JOIN service_endpoints se
             ON se.service_id = cs.id
            AND se.admitted_generation = cs.membership_generation
          WHERE cs.app_id = ? AND cs.published = 1 AND se.readiness = 'ready'
          ORDER BY CASE WHEN se.port = ? THEN 0 ELSE 1 END, cs.id, se.id`,
      )
      .all(appId, primaryPort ?? -1) as GraphEndpointRow[];
    if (rows.length === 0) return null;
    // Hostname routing currently projects one public route per deployment. The deterministic first
    // published service is the default hostname; path/hostname route expansion can add more keys
    // without changing endpoint identity or selection semantics.
    const serviceId = rows[0].service_id;
    return {
      serviceId,
      endpoints: rows
        .filter((row) => row.service_id === serviceId)
        .map((row) => ({
          id: row.endpoint_id,
          serviceId,
          instanceId: row.instance_id,
          host: row.host,
          port: row.port,
          releaseDigest: row.release_digest,
          readiness: 'ready' as const,
        })),
    };
  }
}
