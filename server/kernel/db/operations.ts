import { readStoredValue as readStoredUrls } from '../read-value.ts';
import { namedDatabase } from './named-store.ts';

export function commandReplay(
  owner: string,
  operationId: string,
  signature?: string,
): { found: boolean; result?: any } {
  if (typeof operationId !== 'string' || !operationId || operationId.length > 200)
    throw Object.assign(new Error('operationId required'), { status: 400 });
  const db = namedDatabase('workspace');
  const old = db
    .prepare('SELECT result FROM operations WHERE owner=? AND id=?')
    .get(owner, operationId) as any;
  if (!old) return { found: false };
  const decoded = readStoredUrls(JSON.parse(old.result));
  if (decoded['__workspaceOperation'] === 1) {
    if (signature && decoded.signature && signature !== decoded.signature)
      throw Object.assign(new Error('operationId was already used for a different command'), {
        status: 409,
      });
    return { found: true, result: decoded.result };
  }
  return { found: true, result: decoded };
}
export function command(owner: string, operationId: string, fn: () => any, signature?: string) {
  const db = namedDatabase('workspace');
  return db
    .transaction(() => {
      const replay = commandReplay(owner, operationId, signature);
      if (replay.found) return replay.result;
      const result = fn();
      db.prepare('INSERT INTO operations VALUES(?,?,?)').run(
        owner,
        operationId,
        JSON.stringify({ __workspaceOperation: 1, signature: signature || null, result }),
      );
      return result;
    })
    .immediate();
}
