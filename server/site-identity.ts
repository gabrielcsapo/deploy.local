import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { deployDataPath } from './data-directory.ts';

const SITE_ID_PATTERN = /^[a-z][a-z0-9_-]{2,127}$/;

export interface SiteIdentity {
  siteId: string;
  publicKey: string;
  privateKey: string;
  createdAt: string;
}

export function installSiteIdentity(identity: SiteIdentity): SiteIdentity {
  const path = identityPath(identity.siteId);
  if (!identity.publicKey || !identity.privateKey || !identity.createdAt) {
    throw new Error(`Site identity ${identity.siteId} is incomplete`);
  }
  const suppliedPublic = createPublicKey(identity.publicKey)
    .export({ type: 'spki', format: 'der' })
    .toString('base64');
  const derivedPublic = createPublicKey(createPrivateKey(identity.privateKey))
    .export({ type: 'spki', format: 'der' })
    .toString('base64');
  if (suppliedPublic !== derivedPublic)
    throw new Error('Site identity public and private keys differ');
  if (existsSync(path)) {
    const current = JSON.parse(readFileSync(path, 'utf8')) as SiteIdentity;
    if (current.siteId !== identity.siteId || current.publicKey !== identity.publicKey) {
      throw new Error(`Site identity ${identity.siteId} conflicts with paired fleet identity`);
    }
    return current;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return identity;
}

function identityPath(siteId: string): string {
  if (!SITE_ID_PATTERN.test(siteId)) throw new Error('Invalid site identity');
  return deployDataPath('identities', `${siteId}.json`);
}

export function loadOrCreateSiteIdentity(siteId: string): SiteIdentity {
  const path = identityPath(siteId);
  if (existsSync(path)) {
    const identity = JSON.parse(readFileSync(path, 'utf8')) as SiteIdentity;
    if (identity.siteId !== siteId || !identity.publicKey || !identity.privateKey) {
      throw new Error(`Site identity ${siteId} is corrupt`);
    }
    return identity;
  }

  const keys = generateKeyPairSync('ed25519');
  const identity: SiteIdentity = {
    siteId,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    createdAt: new Date().toISOString(),
  };
  return installSiteIdentity(identity);
}

export function signSitePayload(identity: SiteIdentity, payload: string | Buffer): string {
  return sign(null, Buffer.from(payload), createPrivateKey(identity.privateKey)).toString(
    'base64url',
  );
}

export function verifySitePayload(
  publicKey: string,
  payload: string | Buffer,
  signature: string,
): boolean {
  try {
    return verify(
      null,
      Buffer.from(payload),
      createPublicKey(publicKey),
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}
