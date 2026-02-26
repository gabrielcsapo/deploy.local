import { createHash, randomBytes } from "node:crypto";
import { getRequest } from "./request-context.js";

// In-memory stores (reset on server restart — fine for an example app).
// Use globalThis singletons so the RSC bundle and server entry share the
// same data — without this, register() in the API writes to one Map while
// getSessionUser() in the RSC server component reads from a different one.
type UserRecord = { username: string; passwordHash: string };
type SessionRecord = { username: string; expiresAt: Date };

const users: Map<string, UserRecord> = ((globalThis as any).__example_users__ ??= new Map<
  string,
  UserRecord
>());
const sessions: Map<string, SessionRecord> = ((globalThis as any).__example_sessions__ ??= new Map<
  string,
  SessionRecord
>());

const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

function hashPassword(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function parseCookie(header: string, name: string): string | null {
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function register(username: string, password: string): { token?: string; error?: string } {
  if (!username || !password) return { error: "Missing required fields" };
  if (password.length < 6) return { error: "Password must be at least 6 characters" };
  if (users.has(username)) return { error: "Username already taken" };

  users.set(username, { username, passwordHash: hashPassword(password) });

  const token = generateToken();
  sessions.set(token, {
    username,
    expiresAt: new Date(Date.now() + SESSION_DURATION_MS),
  });

  return { token };
}

export function login(username: string, password: string): { token?: string; error?: string } {
  if (!username || !password) return { error: "Missing required fields" };

  const user = users.get(username);
  if (!user) return { error: "Invalid credentials" };

  if (user.passwordHash !== hashPassword(password)) {
    return { error: "Invalid credentials" };
  }

  const token = generateToken();
  sessions.set(token, {
    username,
    expiresAt: new Date(Date.now() + SESSION_DURATION_MS),
  });

  return { token };
}

export function logout(token: string): void {
  sessions.delete(token);
}

export function validateSession(token: string): { username: string } | null {
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    sessions.delete(token);
    return null;
  }
  return { username: session.username };
}

/**
 * Read the session cookie from the current request (via AsyncLocalStorage)
 * and return the logged-in username, or null if not authenticated.
 *
 * This is the key function that demonstrates onRequest → AsyncLocalStorage
 * → server component integration.
 */
export function getSessionUser(): { username: string } | null {
  const req = getRequest();
  if (!req) return null;

  const cookieHeader = req.headers.get("Cookie") || "";
  const token = parseCookie(cookieHeader, "session");
  if (!token) return null;

  return validateSession(token);
}
