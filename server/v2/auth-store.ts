import { createHash, randomBytes } from 'node:crypto';
import { getDb, getSqlite } from '../store.ts';
import { fail } from '../errors.ts';

export function authDb() {
  getDb();
  return getSqlite()!;
}
export const secret = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export type Grant = { kind: string; hash: string; owner: string; data: string; expires: number };
export function grant(kind: string, owner: string, data: unknown, ttl: number, token = secret()) {
  const db = authDb();
  db.prepare('DELETE FROM v2_auth_grants WHERE expires <= ?').run(Date.now());
  db.prepare('INSERT INTO v2_auth_grants VALUES (?, ?, ?, ?, ?)').run(
    kind,
    digest(token),
    owner,
    JSON.stringify(data),
    Date.now() + ttl,
  );
  return token;
}
export function readGrant(kind: string, token: string): Grant {
  const row = authDb()
    .prepare('SELECT * FROM v2_auth_grants WHERE kind=? AND hash=? AND expires>?')
    .get(kind, digest(token), Date.now()) as Grant | undefined;
  if (!row) fail('This code expired or has already been used. Start again.', 410);
  return row;
}
export function consume(kind: string, token: string): Grant {
  return authDb()
    .transaction(() => {
      const row = readGrant(kind, token);
      authDb().prepare('DELETE FROM v2_auth_grants WHERE kind=? AND hash=?').run(kind, row.hash);
      return row;
    })
    .immediate();
}
export function session(owner: string, label: string) {
  const token = secret();
  const expiresAt = Date.now() + 30 * 86400_000;
  const result = authDb()
    .prepare('INSERT INTO sessions(username,token,label,created_at,expires_at) VALUES(?,?,?,?,?)')
    .run(owner, token, label, new Date().toISOString(), expiresAt);
  return { username: owner, token, expiresAt, sessionId: Number(result.lastInsertRowid) };
}
export function preferences(owner: string): {
  name: string;
  passkeyOffered: boolean;
  firstTaskSeen: boolean;
  welcomed: boolean;
} {
  const row = authDb()
    .prepare('SELECT data FROM v2_account_preferences WHERE username=?')
    .get(owner) as { data: string } | undefined;
  return {
    name: owner,
    passkeyOffered: false,
    firstTaskSeen: false,
    welcomed: false,
    ...JSON.parse(row?.data || '{}'),
  };
}
export function updatePreferences(owner: string, update: Partial<ReturnType<typeof preferences>>) {
  const next = { ...preferences(owner), ...update };
  authDb()
    .prepare(
      'INSERT INTO v2_account_preferences VALUES(?,?) ON CONFLICT(username) DO UPDATE SET data=excluded.data',
    )
    .run(owner, JSON.stringify(next));
  return next;
}
