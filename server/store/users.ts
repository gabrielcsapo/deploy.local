import { randomBytes } from 'node:crypto';
import { getDb, getSqlite } from './connection.ts';
import { sessions, users } from '../schema.ts';
import { eq, sql, and } from 'drizzle-orm';

import {
  configurePersonCredentials,
  hashPassword,
  verifyPersonPassword,
} from '../kernel/auth/person.ts';
export { authenticate, verifyPersonPassword, verifyPersonSession } from '../kernel/auth/person.ts';

// The feature retains its schema/connection; the kernel only sees credential records.
configurePersonCredentials({
  password: (username) => getDb().select().from(users).where(eq(users.username, username)).get(),
  replacePassword(username, password) {
    getDb().update(users).set({ password }).where(eq(users.username, username)).run();
  },
  session: (username, token) =>
    getDb()
      .select()
      .from(sessions)
      .where(and(eq(sessions.username, username), eq(sessions.token, token)))
      .get(),
});

function generateToken() {
  return randomBytes(32).toString('hex');
}

// Sessions expire after 30 days — matches the auth cookie's Max-Age, so the
// browser and DB agree on lifetime. Expired rows are pruned by maintenance.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function createSession(username: string): string {
  const db = getDb();
  const token = generateToken();
  db.insert(sessions)
    .values({
      username,
      token,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    })
    .run();
  return token;
}

// ── Users ───────────────────────────────────────────────────────────────────

export function registerUser(username: string, password: string) {
  const db = getDb();
  const existing = db.select().from(users).where(eq(users.username, username)).get();
  if (existing) {
    return { error: 'User already exists' as const, status: 409 as const };
  }
  const now = new Date().toISOString();
  const userCount = db
    .select({ count: sql<number>`count(*)` })
    .from(users)
    .get()?.count;
  db.insert(users)
    .values({
      username,
      password: hashPassword(password),
      role: userCount === 0 ? 'admin' : 'member',
      createdAt: now,
    })
    .run();
  return { token: createSession(username) };
}

export function loginUser(username: string, password: string) {
  getDb();
  if (!verifyPersonPassword(username, password, true)) {
    return { error: 'Invalid credentials' as const, status: 401 as const };
  }
  return { token: createSession(username) };
}

/** Delete expired sessions (and pre-TTL sessions older than the TTL). */
export function pruneExpiredSessions(): number {
  const sqlite = getSqlite();
  if (!sqlite) return 0;
  const now = Date.now();
  const cutoffIso = new Date(now - SESSION_TTL_MS).toISOString();
  const result = sqlite
    .prepare(
      `DELETE FROM sessions
       WHERE (expires_at IS NOT NULL AND expires_at < ?)
          OR (expires_at IS NULL AND created_at < ?)`,
    )
    .run(now, cutoffIso);
  return result.changes;
}

export function logoutUser(username: string, token: string) {
  const db = getDb();
  db.delete(sessions)
    .where(and(eq(sessions.username, username), eq(sessions.token, token)))
    .run();
}

export function changePassword(username: string, currentPassword: string, newPassword: string) {
  const db = getDb();
  if (!verifyPersonPassword(username, currentPassword)) {
    return { error: 'Invalid current password' as const, status: 401 as const };
  }
  db.update(users)
    .set({ password: hashPassword(newPassword) })
    .where(eq(users.username, username))
    .run();
  return { success: true as const };
}

export function getUser(username: string) {
  const db = getDb();
  const user = db
    .select({ username: users.username, role: users.role, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.username, username))
    .get();
  return user || null;
}

export function isAdmin(username: string): boolean {
  return getUser(username)?.role === 'admin';
}
