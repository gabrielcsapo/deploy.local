import { randomBytes } from 'node:crypto';
import { authDb, grant, readGrant, consume, digest, session } from './auth-store.ts';
import { serverIdentity } from './setup.ts';
import { fail } from './inbox.ts';

export function cliLoginStart() {
  const code = randomBytes(6).toString('hex').toUpperCase();
  const deviceCode = grant('cli', '', { code, state: 'pending' }, 5 * 60_000);
  grant('cli-approve', '', { deviceHash: digest(deviceCode) }, 5 * 60_000, code);
  return {
    deviceCode,
    userCode: code,
    verificationUri: `${serverIdentity().origin}/signin?cli=${code}`,
    interval: 2,
    expiresIn: 300,
  };
}
export function cliApprove(owner: string, code: string, approved: boolean) {
  return authDb()
    .transaction(() => {
      const approval = consume('cli-approve', code);
      const { deviceHash } = JSON.parse(approval.data);
      const result = authDb()
        .prepare('UPDATE v2_auth_grants SET owner=?,data=? WHERE kind=? AND hash=? AND expires>?')
        .run(
          owner,
          JSON.stringify({ state: approved ? 'approved' : 'denied' }),
          'cli',
          deviceHash,
          Date.now(),
        );
      if (!result.changes) fail('This sign-in request expired.', 410);
      return { state: approved ? 'approved' : 'denied' };
    })
    .immediate();
}
export function cliPoll(deviceCode: string) {
  return authDb()
    .transaction(() => {
      const row = readGrant('cli', deviceCode);
      const { state } = JSON.parse(row.data);
      if (state === 'pending') return { state };
      consume('cli', deviceCode);
      if (state === 'denied') return { state };
      const result = session(row.owner, 'deploy CLI');
      return { state: 'approved', username: result.username, token: result.token };
    })
    .immediate();
}
