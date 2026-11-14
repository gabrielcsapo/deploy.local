import { createHash, timingSafeEqual } from 'node:crypto';
import type { PrincipalOf } from './principal.ts';

type Enrollment = {
  id: string;
  name: string;
  createdBy: string;
  usedAt: string | null;
  expiresAt: number;
};
type NodeCredentials = {
  node(id: string): { credentialHash: string | null; revokedAt: string | null } | undefined;
  enrollment(hash: string): Enrollment | undefined;
};
let reader: NodeCredentials | undefined;
export function configureNodeCredentials(value: NodeCredentials) {
  reader = value;
}
function credentials() {
  if (!reader) throw new Error('Node credentials are not configured');
  return reader;
}
export const hashNodeSecret = (value: string) => createHash('sha256').update(value).digest('hex');

export function verifyNodeEnrollment(
  code: string,
): (PrincipalOf<'node-enrollment'> & { createdBy: string }) | null {
  const codeHash = hashNodeSecret(code.trim().toUpperCase());
  const enrollment = credentials().enrollment(codeHash);
  if (!enrollment || enrollment.usedAt || enrollment.expiresAt < Date.now()) return null;
  return {
    kind: 'node-enrollment',
    enrollmentId: enrollment.id,
    name: enrollment.name,
    createdBy: enrollment.createdBy,
  };
}
export function verifyNode(
  nodeId: string | undefined,
  secret: string | undefined,
): PrincipalOf<'node'> | null {
  if (!nodeId || !secret) return null;
  const node = credentials().node(nodeId);
  if (!node?.credentialHash || node.revokedAt) return null;
  const actual = Buffer.from(hashNodeSecret(secret));
  const expected = Buffer.from(node.credentialHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? { kind: 'node', nodeId }
    : null;
}
export function authenticateNode(nodeId: string | undefined, secret: string | undefined) {
  return verifyNode(nodeId, secret) !== null;
}
