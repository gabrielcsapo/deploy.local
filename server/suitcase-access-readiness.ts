import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { getSqlite } from './store.ts';

const ACCESS_PROOF_MAX_AGE_MS = 60 * 60 * 1_000;

export interface SuitcaseClientAccessProof {
  version: 1;
  siteId: string;
  actor: string;
  host: string;
  clientAddressDigest: `sha256:${string}`;
  bootId: string;
  networkFingerprint: string | null;
  observedAt: string;
  expiresAt: string;
  evidence: string;
}

export interface SuitcaseAccessReadiness {
  ready: boolean;
  evidence: string;
  proof?: SuitcaseClientAccessProof;
}

function currentBootId(): string {
  try {
    const value = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return value || `process-${process.pid}`;
  } catch {
    // Windows/macOS native development targets do not expose Linux boot_id. The Docker appliance
    // does, while the process fallback still prevents a proof surviving a core restart in tests.
    return `process-${process.pid}`;
  }
}

function normalizedAddress(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed;
}

function loopbackAddress(value: string): boolean {
  const address = normalizedAddress(value);
  return address === '::1' || address === '0:0:0:0:0:0:0:1' || address.startsWith('127.');
}

function hostName(hostHeader: string): string {
  try {
    return new URL(`https://${hostHeader.trim()}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function privateAccessHost(host: string): boolean {
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.endsWith('.local') || (!host.includes('.') && isIP(host) === 0)) return true;
  if (isIP(host) === 4) {
    const octets = host.split('.').map(Number);
    return (
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 169 && octets[1] === 254)
    );
  }
  return isIP(host) === 6 && /^(f[cd]|fe[89ab])/i.test(host.replace(/^\[/, ''));
}

function parseSummary(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Record evidence only when an authenticated administrator reached the appliance through a
 * non-loopback, private-LAN/mDNS Host. Values supplied by forwarding headers are deliberately
 * ignored because a direct client can forge them.
 */
export function recordSuitcaseClientAccess(input: {
  siteId: string;
  actor: string;
  hostHeader: string;
  remoteAddress: string;
  now?: Date;
}): SuitcaseAccessReadiness {
  const host = hostName(input.hostHeader);
  if (loopbackAddress(input.remoteAddress) || !privateAccessHost(host)) {
    return {
      ready: false,
      evidence:
        'Open the suitcase dashboard through its private LAN address or .local name from an administrator client.',
    };
  }
  const sqlite = getSqlite()!;
  const site = sqlite
    .prepare(
      `SELECT readiness_summary, network_fingerprint
         FROM sites
        WHERE id = ? AND kind = 'suitcase' AND credential_status = 'active'
          AND removed_at IS NULL AND revoked_at IS NULL`,
    )
    .get(input.siteId) as
    | { readiness_summary: string; network_fingerprint: string | null }
    | undefined;
  if (!site) return { ready: false, evidence: 'The local suitcase identity is unavailable.' };
  const now = input.now ?? new Date();
  const proof: SuitcaseClientAccessProof = {
    version: 1,
    siteId: input.siteId,
    actor: input.actor,
    host,
    clientAddressDigest: `sha256:${createHash('sha256')
      .update(`${input.siteId}\0${normalizedAddress(input.remoteAddress)}`)
      .digest('hex')}`,
    bootId: currentBootId(),
    networkFingerprint: site.network_fingerprint,
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ACCESS_PROOF_MAX_AGE_MS).toISOString(),
    evidence: `Authenticated administrator reached https://${host} through the published non-loopback suitcase path.`,
  };
  const summary = parseSummary(site.readiness_summary);
  summary.clientAccessProof = proof;
  sqlite
    .prepare('UPDATE sites SET readiness_summary = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(summary), proof.observedAt, input.siteId);
  return { ready: true, evidence: proof.evidence, proof };
}

export function currentSuitcaseClientAccess(
  siteId: string,
  now = new Date(),
): SuitcaseAccessReadiness {
  const site = getSqlite()!
    .prepare(
      `SELECT readiness_summary, network_fingerprint
         FROM sites
        WHERE id = ? AND kind = 'suitcase' AND credential_status = 'active'
          AND removed_at IS NULL AND revoked_at IS NULL`,
    )
    .get(siteId) as { readiness_summary: string; network_fingerprint: string | null } | undefined;
  if (!site) return { ready: false, evidence: 'The local suitcase identity is unavailable.' };
  const value = parseSummary(site.readiness_summary).clientAccessProof;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ready: false,
      evidence:
        'No administrator client has proven the published suitcase access path on this boot and network.',
    };
  }
  const proof = value as SuitcaseClientAccessProof;
  const valid =
    proof.version === 1 &&
    proof.siteId === siteId &&
    proof.bootId === currentBootId() &&
    proof.networkFingerprint === site.network_fingerprint &&
    Date.parse(proof.observedAt) <= now.getTime() &&
    Date.parse(proof.expiresAt) > now.getTime();
  return valid
    ? { ready: true, evidence: proof.evidence, proof }
    : {
        ready: false,
        evidence:
          'The prior client access proof is stale for the current boot or network; open the suitcase dashboard again.',
      };
}
