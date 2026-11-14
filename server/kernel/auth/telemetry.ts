import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../db/sqlite.ts';

export function issueTelemetryToken(db: Database, name: string) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO telemetry_tokens VALUES(?,?,?)').run(hashToken(token), name, Date.now());
  return token;
}
function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
export function deploymentForToken(db: Database, token: string): string | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return (
    (
      db
        .prepare('SELECT deployment_name FROM telemetry_tokens WHERE token_hash=?')
        .get(hashToken(token)) as { deployment_name: string } | undefined
    )?.deployment_name ?? null
  );
}
