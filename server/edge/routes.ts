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
import { registerHost, unregisterHost } from '../mdns.ts';
import { startProxies, stopProxies, type ExtraPortMapping } from '../tcp-proxy.ts';

export interface EdgeRoute {
  name: string;
  port: number | null;
  /** JSON string of ExtraPortMapping[] as stored on the row. */
  extraPorts: string | null;
}

interface DeploymentRow {
  name: string;
  port: number | null;
  extra_ports: string | null;
}

export class RouteTable {
  private sqlite: InstanceType<typeof Database>;
  private cache = new Map<string, EdgeRoute>();

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
      .prepare('SELECT name, port, extra_ports FROM deployments')
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
      .prepare('SELECT name, port, extra_ports FROM deployments WHERE name = ?')
      .get(name) as DeploymentRow | undefined;
    if (!row) {
      this.remove(name);
    } else {
      this.apply(row);
    }
  }

  private apply(row: DeploymentRow) {
    const prev = this.cache.get(row.name);
    this.cache.set(row.name, {
      name: row.name,
      port: row.port,
      extraPorts: row.extra_ports,
    });

    // mDNS registration is idempotent (registerHost keeps a Set).
    registerHost(row.name);

    // Restart TCP proxies only when the extra-port set actually changed —
    // status-only row updates must not churn listening sockets.
    if ((row.extra_ports ?? null) !== (prev?.extraPorts ?? null)) {
      if (row.extra_ports) {
        try {
          const ports = JSON.parse(row.extra_ports) as ExtraPortMapping[];
          if (ports.length > 0) {
            startProxies(row.name, ports);
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
    this.cache.delete(name);
    unregisterHost(name);
    stopProxies(name);
  }

  close() {
    this.sqlite.close();
  }
}
