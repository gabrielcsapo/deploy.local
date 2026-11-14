import { db as workspaceDb } from '../workspace/store.ts';
import { grant } from './auth-store.ts';
import { revokeDeviceSession } from '../kernel/auth/devices.ts';
import { serverIdentity } from './setup.ts';
import { fail } from '../kernel/errors.ts';

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
export {
  exchangeDevice,
  devices,
  pairedDeviceActive,
  pairedDeviceForRequest,
} from '../kernel/auth/devices.ts';

export function removeDevice(owner: string, id: string) {
  revokeDeviceSession(owner, id);
  workspaceDb
    .prepare(
      "DELETE FROM records WHERE kind='v2-device' AND owner=? AND json_extract(data,'$.pairedDeviceId')=?",
    )
    .run(owner, id);
}
