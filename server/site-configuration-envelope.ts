import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { parseStoredApplicationSpec } from './application-spec.ts';
import {
  resolveApplicationConfiguration,
  setDeclaredConfigurationValue,
} from './application-configuration.ts';
import { appendLocalFleetEvent, resolveLocalSiteId } from './multisite.ts';
import { getApplicationSpecRevision, getDeployment, getSqlite } from './store.ts';

interface EncryptedConfigurationValue {
  key: string;
  valueType: string;
  revision: number;
  nonce: string;
  tag: string;
  ciphertext: string;
}

export interface SiteConfigurationProjection {
  targetSiteId: string;
  appId: string;
  specDigest: string;
  configurationDigest: string;
  envelopes: EncryptedConfigurationValue[];
  missingApplicationValues: string[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function keyForCredentialHash(credentialHash: string, siteId: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(credentialHash)) throw new Error('Site credential hash is invalid');
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(credentialHash, 'hex'),
      Buffer.from(siteId),
      Buffer.from('deploy.local/site-configuration/v1'),
      32,
    ),
  );
}

function aad(projection: {
  appId: string;
  siteId: string;
  specDigest: string;
  key: string;
  valueType: string;
  revision: number;
}): Buffer {
  return Buffer.from(JSON.stringify(projection));
}

function encryptValue(input: {
  keyBytes: Buffer;
  appId: string;
  siteId: string;
  specDigest: string;
  key: string;
  valueType: string;
  revision: number;
  value: unknown;
}): EncryptedConfigurationValue {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', input.keyBytes, nonce);
  cipher.setAAD(
    aad({
      appId: input.appId,
      siteId: input.siteId,
      specDigest: input.specDigest,
      key: input.key,
      valueType: input.valueType,
      revision: input.revision,
    }),
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(input.value), 'utf8'),
    cipher.final(),
  ]);
  return {
    key: input.key,
    valueType: input.valueType,
    revision: input.revision,
    nonce: nonce.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}

function decryptValue(input: {
  envelope: EncryptedConfigurationValue;
  keyBytes: Buffer;
  appId: string;
  siteId: string;
  specDigest: string;
}): unknown {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    input.keyBytes,
    Buffer.from(input.envelope.nonce, 'base64url'),
  );
  decipher.setAAD(
    aad({
      appId: input.appId,
      siteId: input.siteId,
      specDigest: input.specDigest,
      key: input.envelope.key,
      valueType: input.envelope.valueType,
      revision: input.envelope.revision,
    }),
  );
  decipher.setAuthTag(Buffer.from(input.envelope.tag, 'base64url'));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(input.envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8'),
  ) as unknown;
}

/** Encrypt every application-scoped value to one paired site; site-scoped values stay local. */
export function projectApplicationConfigurationToSite(input: {
  appId: string;
  siteId: string;
  actor: string;
}): SiteConfigurationProjection {
  const sqlite = getSqlite()!;
  const deployment = sqlite
    .prepare(
      `SELECT name, desired_spec_digest, active_spec_digest
         FROM deployments WHERE app_id = ?`,
    )
    .get(input.appId) as
    | { name: string; desired_spec_digest: string | null; active_spec_digest: string | null }
    | undefined;
  if (!deployment) throw new Error('Application not found');
  const site = sqlite
    .prepare(
      `SELECT credential_hash FROM sites
        WHERE id = ? AND kind = 'suitcase' AND credential_status = 'active'
          AND revoked_at IS NULL`,
    )
    .get(input.siteId) as { credential_hash: string | null } | undefined;
  if (!site?.credential_hash) throw new Error('Active suitcase credential is unavailable');
  const specDigest = deployment.desired_spec_digest || deployment.active_spec_digest;
  if (!specDigest) throw new Error('Application has no immutable revision');
  const revision = getApplicationSpecRevision(deployment.name, specDigest);
  if (!revision) throw new Error('Application revision not found');
  const spec = parseStoredApplicationSpec(revision.normalizedSpec);
  const resolved = resolveApplicationConfiguration({
    deploymentName: deployment.name,
    specDigest,
    declarations: spec.configuration,
  });
  const keyBytes = keyForCredentialHash(site.credential_hash, input.siteId);
  const rows = new Map(
    (
      sqlite
        .prepare(
          `SELECT key, revision FROM application_configuration_values
          WHERE deployment_name = ? AND spec_digest = ? AND site_id = ''`,
        )
        .all(deployment.name, specDigest) as Array<{ key: string; revision: number }>
    ).map((row) => [row.key, row.revision]),
  );
  const envelopes = Object.entries(spec.configuration)
    .filter(([, declaration]) => declaration.scope === 'application')
    .filter(([key]) => Object.hasOwn(resolved.values, key))
    .map(([key, declaration]) =>
      encryptValue({
        keyBytes,
        appId: input.appId,
        siteId: input.siteId,
        specDigest,
        key,
        valueType: declaration.type,
        revision: rows.get(key) || 0,
        value: resolved.values[key],
      }),
    );
  const projection: SiteConfigurationProjection = {
    targetSiteId: input.siteId,
    appId: input.appId,
    specDigest,
    configurationDigest: resolved.digest,
    envelopes,
    missingApplicationValues: resolved.missing.filter(
      (key) => spec.configuration[key]?.scope === 'application',
    ),
  };
  appendLocalFleetEvent({
    originSiteId: resolveLocalSiteId(),
    appId: input.appId,
    actor: input.actor,
    operation: 'application.configuration.projected',
    payload: projection as unknown as Record<string, unknown>,
  });
  return projection;
}

export function projectApplicationConfigurationToReplicas(appId: string, actor: string): number {
  const sites = getSqlite()!
    .prepare(
      `SELECT r.site_id FROM app_replicas r
        JOIN sites s ON s.id = r.site_id
       WHERE r.app_id = ? AND r.removed_at IS NULL AND s.kind = 'suitcase'
         AND s.credential_status = 'active' AND s.revoked_at IS NULL`,
    )
    .all(appId) as Array<{ site_id: string }>;
  for (const site of sites)
    projectApplicationConfigurationToSite({ appId, siteId: site.site_id, actor });
  return sites.length;
}

/** Decrypt a signed, target-specific event with the paired credential and re-encrypt locally. */
export function applySiteConfigurationProjection(input: {
  projection: SiteConfigurationProjection;
  localSiteId: string;
  siteCredential: string;
  actor: string;
}): { applied: number; missingSiteValues: string[] } {
  if (input.projection.targetSiteId !== input.localSiteId)
    return { applied: 0, missingSiteValues: [] };
  const deployment = getSqlite()!
    .prepare('SELECT name FROM deployments WHERE app_id = ?')
    .get(input.projection.appId) as { name: string } | undefined;
  if (!deployment)
    throw new Error('Configuration projection arrived before its application revision');
  const revision = getApplicationSpecRevision(deployment.name, input.projection.specDigest);
  if (!revision) throw new Error('Configuration projection references an unavailable revision');
  const spec = parseStoredApplicationSpec(revision.normalizedSpec);
  const keyBytes = keyForCredentialHash(sha256(input.siteCredential), input.localSiteId);
  let applied = 0;
  for (const envelope of input.projection.envelopes) {
    const declaration = spec.configuration[envelope.key];
    if (
      !declaration ||
      declaration.scope !== 'application' ||
      declaration.type !== envelope.valueType
    ) {
      throw new Error(`Configuration envelope ${envelope.key} does not match its declaration`);
    }
    setDeclaredConfigurationValue({
      deploymentName: deployment.name,
      specDigest: input.projection.specDigest,
      declarations: spec.configuration,
      key: envelope.key,
      value: decryptValue({
        envelope,
        keyBytes,
        appId: input.projection.appId,
        siteId: input.localSiteId,
        specDigest: input.projection.specDigest,
      }),
      updatedBy: input.actor,
    });
    applied++;
  }
  const readiness = resolveApplicationConfiguration({
    deploymentName: deployment.name,
    specDigest: input.projection.specDigest,
    declarations: spec.configuration,
    siteId: input.localSiteId,
  });
  return {
    applied,
    missingSiteValues: readiness.missing.filter((key) => spec.configuration[key]?.scope === 'site'),
  };
}

export function currentApplicationId(deploymentName: string): string | undefined {
  return getDeployment(deploymentName)?.appId || undefined;
}
