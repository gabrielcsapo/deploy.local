import { getDb } from './connection.ts';
import { history } from '../schema.ts';
import { eq } from 'drizzle-orm';

// ── Deployment history ───────────────────────────────────────────────────────

interface DeployEvent {
  action: string;
  username?: string;
  type?: string;
  port?: number;
  containerId?: string;
  buildLogId?: number;
  durationMs?: number;
  source?: 'cli' | 'ui' | 'auto';
}

export function addDeployEvent(name: string, event: DeployEvent) {
  const db = getDb();
  db.insert(history)
    .values({
      deploymentName: name,
      action: event.action,
      username: event.username || null,
      type: event.type || null,
      port: event.port || null,
      containerId: event.containerId || null,
      buildLogId: event.buildLogId ?? null,
      durationMs: event.durationMs ?? null,
      source: event.source || null,
      timestamp: new Date().toISOString(),
    })
    .run();
}

export function getDeployHistory(name: string) {
  const db = getDb();
  return db.select().from(history).where(eq(history.deploymentName, name)).all();
}
