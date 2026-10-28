import { randomUUID } from 'node:crypto';
import { authDb, grant, consume, session } from './auth-store.ts';
import { serverIdentity } from './setup.ts';
import { fail } from './inbox.ts';

export function pairDevice(owner: string) {
  const identity = serverIdentity();
  if (!identity.fingerprint) fail('SER has not created its certificate yet.', 503);
  const token = grant('pair', owner, {}, 5 * 60_000);
  return {
    version: 1,
    address: identity.origin,
    fingerprint: identity.fingerprint,
    token,
    expiresAt: Date.now() + 5 * 60_000,
  };
}
export function exchangeDevice(token: string, name: string) {
  if (typeof name !== 'string' || !name.trim() || name.length > 100) fail('Enter a device name.');
  return authDb()
    .transaction(() => {
      const row = consume('pair', token);
      const result = session(row.owner, name.trim());
      const id = randomUUID();
      authDb()
        .prepare('INSERT INTO v2_devices VALUES(?,?,?,?,?)')
        .run(id, row.owner, result.sessionId, name.trim(), new Date().toISOString());
      return { id, username: result.username, token: result.token, expiresAt: result.expiresAt };
    })
    .immediate();
}
export function devices(owner: string) {
  return authDb()
    .prepare(`SELECT d.id,d.name,d.created_at AS createdAt,s.expires_at AS expiresAt
    FROM v2_devices d JOIN sessions s ON s.id=d.session_id WHERE d.username=? AND s.expires_at>?`)
    .all(owner, Date.now());
}
export function removeDevice(owner: string, id: string) {
  authDb()
    .transaction(() => {
      const row = authDb()
        .prepare('SELECT session_id FROM v2_devices WHERE id=? AND username=?')
        .get(id, owner) as { session_id: number } | undefined;
      if (!row) fail('Device not found.', 404);
      authDb().prepare('DELETE FROM sessions WHERE id=? AND username=?').run(row.session_id, owner);
      authDb().prepare('DELETE FROM v2_devices WHERE id=? AND username=?').run(id, owner);
    })
    .immediate();
}
