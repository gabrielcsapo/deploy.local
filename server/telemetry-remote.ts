/** SER-only authorization for the computer relay. Attribution comes exclusively from the token. */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getRequestsSqlite } from './requests-db.ts';
import { authenticateNode, readDeploymentRecord } from './store.ts';
import { deploymentForToken, issueTelemetryToken, ingestServer } from './telemetry.ts';
import { readTelemetryBody, TelemetryRateLimit } from './telemetry-http.ts';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export function issueRemoteTelemetryToken(
  db: Database.Database,
  name: string,
  node: string,
  owner: string,
) {
  return db.transaction(() => {
    const token = issueTelemetryToken(db, name);
    db.prepare('INSERT INTO telemetry_remote_tokens VALUES(?,?,?)').run(hash(token), node, owner);
    return token;
  })();
}
const rate = new TelemetryRateLimit(240);
export async function handleRemoteTelemetry(req: IncomingMessage, res: ServerResponse) {
  const end = (status: number) => {
    res.writeHead(status, { 'Cache-Control': 'no-store' });
    res.end();
  };
  try {
    const node = req.headers['x-deploy-node-id'];
    const secret = req.headers['x-deploy-node-secret'];
    if (typeof node !== 'string' || typeof secret !== 'string' || !authenticateNode(node, secret)) {
      req.resume();
      return end(401);
    }
    if (!rate.allow(node)) {
      req.resume();
      return end(429);
    }
    const token = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : '';
    const db = getRequestsSqlite();
    const name = deploymentForToken(db, token);
    const grant = name
      ? (db
          .prepare('SELECT node_id,owner FROM telemetry_remote_tokens WHERE token_hash=?')
          .get(hash(token)) as { node_id: string; owner: string } | undefined)
      : undefined;
    if (
      !name ||
      !grant ||
      grant.node_id !== node ||
      readDeploymentRecord(name)?.username !== grant.owner
    ) {
      req.resume();
      return end(401);
    }
    ingestServer(db, name, await readTelemetryBody(req, 512 * 1024));
    end(204);
  } catch (error) {
    end((error as { status?: number }).status ?? 503);
  }
}
