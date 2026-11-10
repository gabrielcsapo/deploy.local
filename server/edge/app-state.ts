import { openDatabase, type Database } from '../sqlite.ts';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AddressApp, AppAvailability } from './app-pages.ts';
import type { LiveApp, Project, Rollback, Release } from '../../shared/v2/contracts.ts';

interface Deployment {
  name: string;
  username: string;
  status: string;
  computer: string | null;
}
interface RecordRow {
  kind: string;
  owner: string;
  data: string;
}
interface PublicRecord {
  app?: LiveApp;
  project?: Project;
  release?: Release;
  rollback?: Rollback;
  state?: string;
}

export function availabilityFor(
  deployment: Deployment,
  records: RecordRow[],
): AppAvailability | null {
  const owned: PublicRecord[] = records
    .filter((row) => row.owner === deployment.username)
    .flatMap((row) => {
      try {
        return [JSON.parse(row.data) as PublicRecord];
      } catch {
        return [];
      }
    });
  const live = owned.find((row) => row.app?.appId === deployment.name)?.app;
  const projects = owned.filter((row) =>
    row.project?.apps.some((app) => app.id === deployment.name || app.name === deployment.name),
  );
  const rollback = owned.find(
    (row) =>
      row.state === 'running' &&
      row.rollback &&
      projects.some((project) => project.project?.id === row.rollback?.projectId) &&
      !row.rollback.steps.some((step) => step.name === 'activate' && step.state === 'done'),
  )?.rollback;
  const base = {
    name: deployment.name,
    ...(live?.name ? { title: live.name } : {}),
    ...(deployment.computer ? { computer: deployment.computer } : {}),
  };
  if (rollback)
    return {
      ...base,
      state: 'rolling-back',
      startedAt: rollback.steps.find((step) => step.startedAt)?.startedAt,
    };
  if (deployment.status === 'stopped') return { ...base, state: 'stopped' };
  return null;
}

// The edge never initializes schemas or imports the control-plane stores. This snapshot
// also notices rollback records when no route:changed IPC hint has been sent yet.
export class AppStateReader {
  private deployments: Database;
  private workspace?: Database;
  private workspaceFile: string;
  private checkedAt = 0;
  private apps: AddressApp[] = [];
  private states = new Map<string, AppAvailability>();
  constructor(dbFile: string) {
    this.deployments = openDatabase(dbFile, {
      readonly: true,
      fileMustExist: true,
      busyTimeoutMs: 100,
    });
    this.workspaceFile = join(dirname(dbFile), 'workspace', 'workspace.db');
  }
  private refresh() {
    if (Date.now() - this.checkedAt < 1000) return;
    this.checkedAt = Date.now();
    try {
      const rows = this.deployments
        .prepare(
          'SELECT d.name, d.username, d.status, n.name AS computer FROM deployments d LEFT JOIN nodes n ON n.id = d.active_node_id',
        )
        .all() as Deployment[];
      let records: RecordRow[] = [];
      try {
        if (!this.workspace && existsSync(this.workspaceFile)) {
          this.workspace = openDatabase(this.workspaceFile, {
            readonly: true,
            fileMustExist: true,
            busyTimeoutMs: 100,
          });
        }
        records = (this.workspace
          ?.prepare(
            "SELECT kind, owner, data FROM records WHERE kind IN ('v2-health','v2-release','v2-rollback')",
          )
          .all() || []) as RecordRow[];
      } catch {
        /* Older or initializing installs still have authoritative stopped state. */
      }
      this.apps = rows.map((row) => ({ name: row.name }));
      this.states.clear();
      for (const row of rows) {
        const state = availabilityFor(row, records);
        if (state) this.states.set(row.name, state);
      }
    } catch {
      /* Retain the last snapshot during a short database lock. */
    }
  }
  listApps() {
    this.refresh();
    return this.apps;
  }
  getAvailability(name: string) {
    this.refresh();
    return this.states.get(name) || null;
  }
  close() {
    this.workspace?.close();
    this.deployments.close();
  }
}
