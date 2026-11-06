import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { getDb, getSqlite } from './connection.ts';
import { sessions, users } from '../schema.ts';
import { eq, sql, and } from 'drizzle-orm';

// ── Password hashing ─────────────────────────────────────────────────────────
// scrypt with a per-user random salt, stored as `scrypt:<salt>:<hash>`.
// Accounts created before this change hold a bare unsalted sha256 hex digest;
// verifyPassword still accepts those and loginUser transparently rehashes on
// the next successful login.

function legacySha256(password: string) {
  return createHash('sha256').update(password).digest('hex');
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  try {
    if (stored.startsWith('scrypt:')) {
      const [, saltHex, hashHex] = stored.split(':');
      const expected = Buffer.from(hashHex, 'hex');
      const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
      return expected.length > 0 && timingSafeEqual(actual, expected);
    }
    const expected = Buffer.from(stored, 'hex');
    const actual = Buffer.from(legacySha256(password), 'hex');
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

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
  const db = getDb();
  const user = db.select().from(users).where(eq(users.username, username)).get();
  if (!user || !verifyPassword(password, user.password)) {
    return { error: 'Invalid credentials' as const, status: 401 as const };
  }
  // Transparent upgrade: legacy sha256 hashes are replaced with scrypt the
  // first time the password is presented and verified.
  if (!user.password.startsWith('scrypt:')) {
    db.update(users)
      .set({ password: hashPassword(password) })
      .where(eq(users.username, username))
      .run();
  }
  return { token: createSession(username) };
}

export function authenticate(
  username: string | null | undefined,
  token: string | null | undefined,
) {
  if (!username || !token) return false;
  const db = getDb();
  const session = db
    .select()
    .from(sessions)
    .where(and(eq(sessions.username, username), eq(sessions.token, token)))
    .get();
  if (!session) return false;
  // Sessions created before TTLs existed have no expiry — accept them; the
  // maintenance pruner ages them out by createdAt instead.
  if (session.expiresAt != null && session.expiresAt < Date.now()) return false;
  return true;
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
  const user = db.select().from(users).where(eq(users.username, username)).get();
  if (!user || !verifyPassword(currentPassword, user.password)) {
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
