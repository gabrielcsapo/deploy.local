import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { PrincipalOf } from './principal.ts';

type PersonCredentials = {
  password(username: string): { password: string } | undefined;
  replacePassword(username: string, password: string): void;
  session(username: string, token: string): { expiresAt: number | null } | undefined;
};
let reader: PersonCredentials | undefined;
export function configurePersonCredentials(value: PersonCredentials) {
  reader = value;
}
function credentials() {
  if (!reader) throw new Error('Person credentials are not configured');
  return reader;
}

// Preserve scrypt bytes, legacy SHA-256 acceptance and timing-safe comparison.
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}
function matchesPassword(password: string, stored: string): boolean {
  try {
    if (stored.startsWith('scrypt:')) {
      const [, saltHex, hashHex] = stored.split(':');
      const expected = Buffer.from(hashHex, 'hex');
      const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
      return expected.length > 0 && timingSafeEqual(actual, expected);
    }
    const expected = Buffer.from(stored, 'hex');
    const actual = createHash('sha256').update(password).digest();
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
export function verifyPersonPassword(
  username: string,
  password: string,
  upgrade = false,
): PrincipalOf<'person'> | null {
  const source = credentials();
  const user = source.password(username);
  if (!user || !matchesPassword(password, user.password)) return null;
  if (upgrade && !user.password.startsWith('scrypt:'))
    source.replacePassword(username, hashPassword(password));
  return { kind: 'person', username };
}
export function verifyPersonSession(
  username: string | null | undefined,
  token: string | null | undefined,
): PrincipalOf<'person'> | null {
  if (!username || !token) return null;
  const session = credentials().session(username, token);
  if (!session) return null;
  // Pre-TTL sessions remain accepted, just as before.
  if (session.expiresAt != null && session.expiresAt < Date.now()) return null;
  return { kind: 'person', username };
}
export function authenticate(
  username: string | null | undefined,
  token: string | null | undefined,
) {
  return verifyPersonSession(username, token) !== null;
}
