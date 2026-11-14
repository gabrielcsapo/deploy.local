import type { Database } from '../db/sqlite.ts';
import { deploymentForToken } from './telemetry.ts';
import type { IncomingMessage } from 'node:http';
import { readGrant } from './grants.ts';
import { workerAuthentication } from './worker.ts';
import { pairedDeviceForRequest } from './devices.ts';
import type { PrincipalOf } from './principal.ts';

// Compatibility functions retain their exact result shapes. Typed entry points delegate
// to those same verifiers; they never select another credential after a refusal.
export function verifyGrant(kind: string, token: string): PrincipalOf<'grant'> {
  const row = readGrant(kind, token);
  return { kind: 'grant', grantKind: row.kind, owner: row.owner };
}
export function verifyWorker(req: IncomingMessage): PrincipalOf<'worker'> | null {
  const worker = workerAuthentication(req);
  return worker ? { kind: 'worker', ...worker } : null;
}
/** The owner is already authenticated by the caller, as in the existing device adapter. */
export function verifyPairedDevice(
  owner: string,
  req: IncomingMessage,
): PrincipalOf<'device'> | undefined {
  const deviceId = pairedDeviceForRequest(owner, req);
  return deviceId ? { kind: 'device', owner, deviceId } : undefined;
}

export function verifyTelemetry(db: Database, token: string): PrincipalOf<'telemetry'> | null {
  const application = deploymentForToken(db, token);
  return application === null ? null : { kind: 'telemetry', application };
}
