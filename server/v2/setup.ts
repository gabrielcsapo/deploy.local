import { randomBytes, X509Certificate } from 'node:crypto';
import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';
import { deployDataPath } from '../data-directory.ts';
import { registerUser, getDiscoverableDeployments } from '../store.ts';
import { authDb, consume, grant, updatePreferences } from './auth-store.ts';
import { fail } from './inbox.ts';

export function hasOwner() {
  return !!authDb().prepare('SELECT 1 FROM users LIMIT 1').get();
}
// Local installer only. Never issue ownership codes from a public HTTP route.
export function issueSetupCode() {
  return authDb()
    .transaction(() => {
      if (hasOwner()) fail('An account already exists. Sign in with your password.', 409);
      authDb().prepare("DELETE FROM v2_auth_grants WHERE kind='setup'").run();
      const code = randomBytes(8).toString('hex').toUpperCase().match(/.{4}/g)!.join('-');
      grant('setup', '', {}, 30 * 60_000, code);
      return { code, expiresAt: Date.now() + 30 * 60_000 };
    })
    .immediate();
}
export function setupAccount(input: {
  code?: unknown;
  username?: unknown;
  password?: unknown;
  name?: unknown;
}) {
  const { code, username, password } = input;
  if (
    typeof code !== 'string' ||
    typeof username !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(username)
  )
    fail('Enter the setup code and a username using letters, numbers, hyphens or underscores.');
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024)
    fail('Use a password with at least 12 characters (at most 1024).');
  return authDb()
    .transaction(() => {
      if (hasOwner()) fail('An account already exists. Sign in with your password.', 409);
      consume('setup', code.trim().toUpperCase());
      const result = registerUser(username, password);
      if ('error' in result) fail(result.error!, result.status);
      updatePreferences(username, {
        name: typeof input.name === 'string' ? input.name.slice(0, 100) : username,
      });
      return { username, token: result.token! };
    })
    .immediate();
}
export function serverIdentity() {
  let fingerprint: string | null = null;
  try {
    fingerprint = new X509Certificate(readFileSync(deployDataPath('certs', 'ca.crt')))
      .fingerprint256;
  } catch {
    /* Certificate not created yet. */
  }
  return {
    name: hostname(),
    origin: process.env.DEPLOY_PUBLIC_ORIGIN || 'https://deploy.local',
    fingerprint,
  };
}
export function appsAtHome() {
  return getDiscoverableDeployments().map((app) => ({
    name: app.name,
    type: app.type,
    status: app.status,
    address: `https://${app.name}.local`,
  }));
}

export function recoveryProgress() {
  try {
    return JSON.parse(readFileSync(deployDataPath('v2-recovery.json'), 'utf8'));
  } catch {
    return { state: 'idle', projects: [] };
  }
}
