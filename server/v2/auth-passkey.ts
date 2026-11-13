import {
  generateRegistrationOptions,
  generateAuthenticationOptions,
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { authDb, consume, grant, session, updatePreferences } from './auth-store.ts';
import { serverIdentity } from './setup.ts';
import { fail } from '../kernel/errors.ts';

type Passkey = {
  id: string;
  username: string;
  public_key: string;
  counter: number;
  transports: string;
};
export function passkeys(owner: string) {
  return authDb().prepare('SELECT * FROM v2_passkeys WHERE username=?').all(owner) as Passkey[];
}
export function relyingParty() {
  const url = new URL(serverIdentity().origin);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost')
    fail('Passkeys require HTTPS.', 503);
  return { rpID: url.hostname, origin: url.origin };
}
export async function registrationOptions(owner: string) {
  const { rpID, origin } = relyingParty();
  const options = await generateRegistrationOptions({
    rpName: 'deploy.local',
    rpID,
    userName: owner,
    userID: new TextEncoder().encode(owner),
    attestationType: 'none',
    excludeCredentials: passkeys(owner).map((key) => ({ id: key.id })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  const challengeId = grant(
    'register',
    owner,
    { challenge: options.challenge, origin, rpID },
    5 * 60_000,
  );
  return { options, challengeId };
}
export async function registrationVerify(
  owner: string,
  challengeId: string,
  response: RegistrationResponseJSON,
) {
  const row = consume('register', challengeId);
  if (row.owner !== owner) fail('This passkey request belongs to another account.', 403);
  const expected = JSON.parse(row.data);
  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge: expected.challenge,
    expectedOrigin: expected.origin,
    expectedRPID: expected.rpID,
    requireUserVerification: true,
  });
  if (!result.verified || !result.registrationInfo) fail('Passkey could not be verified.', 401);
  const credential = result.registrationInfo.credential;
  authDb()
    .prepare('INSERT INTO v2_passkeys VALUES(?,?,?,?,?,?)')
    .run(
      credential.id,
      owner,
      Buffer.from(credential.publicKey).toString('base64url'),
      credential.counter,
      JSON.stringify(credential.transports || []),
      new Date().toISOString(),
    );
  updatePreferences(owner, { passkeyOffered: true });
  return { verified: true };
}
export async function loginOptions() {
  const { rpID, origin } = relyingParty();
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
  const challengeId = grant(
    'passkey-login',
    '',
    { challenge: options.challenge, origin, rpID },
    5 * 60_000,
  );
  return { options, challengeId };
}
export async function loginVerify(challengeId: string, response: AuthenticationResponseJSON) {
  const row = consume('passkey-login', challengeId);
  const expected = JSON.parse(row.data);
  const key = authDb().prepare('SELECT * FROM v2_passkeys WHERE id=?').get(response.id) as
    | Passkey
    | undefined;
  if (!key) fail('Passkey could not be verified. Use your password.', 401);
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge: expected.challenge,
    expectedOrigin: expected.origin,
    expectedRPID: expected.rpID,
    requireUserVerification: true,
    credential: {
      id: key.id,
      publicKey: new Uint8Array(Buffer.from(key.public_key, 'base64url')),
      counter: key.counter,
      transports: JSON.parse(key.transports),
    },
  });
  if (!result.verified) fail('Passkey could not be verified.', 401);
  return authDb()
    .transaction(() => {
      const updated = authDb()
        .prepare('UPDATE v2_passkeys SET counter=? WHERE id=? AND counter=?')
        .run(result.authenticationInfo.newCounter, key.id, key.counter);
      if (!updated.changes) fail('Passkey changed during sign-in. Try again.', 409);
      return session(key.username, 'Passkey');
    })
    .immediate();
}
