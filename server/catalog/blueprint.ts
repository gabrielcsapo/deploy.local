import { verify } from 'node:crypto';
import { compileApplicationManifest } from '../application-spec.ts';
import { catalogContentDigest } from './canonical.ts';
import {
  CATALOG_BLUEPRINT_SCHEMA,
  type CatalogBlueprintContent,
  type CatalogBlueprintRelease,
  type CatalogTrustStore,
  type ValidatedCatalogRelease,
} from './types.ts';

const ID_PATTERN = /^[a-z][a-z0-9.-]{0,127}$/;
const RELEASE_PATTERN = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/;
const IMAGE_DIGEST_PATTERN = /^.+@sha256:([a-f0-9]{64})$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export class CatalogBlueprintError extends Error {
  readonly issues: readonly string[];

  constructor(issues: string[] | string) {
    const list = Array.isArray(issues) ? issues : [issues];
    super(list.length === 1 ? list[0] : `Invalid catalog blueprint:\n- ${list.join('\n- ')}`);
    this.name = 'CatalogBlueprintError';
    this.issues = list;
  }
}

export function blueprintContent(release: CatalogBlueprintRelease): CatalogBlueprintContent {
  const { contentDigest: _digest, signature: _signature, ...content } = release;
  return content;
}

export function validateCatalogBlueprint(
  input: unknown,
  trustStore: CatalogTrustStore,
): ValidatedCatalogRelease {
  const issues = validateBlueprintShape(input);
  if (issues.length > 0) throw new CatalogBlueprintError(issues);
  const release = input as CatalogBlueprintRelease;
  if (release.schema !== CATALOG_BLUEPRINT_SCHEMA) {
    issues.push(`schema must be ${JSON.stringify(CATALOG_BLUEPRINT_SCHEMA)}`);
  }
  if (!ID_PATTERN.test(release.id)) issues.push(`id must match ${ID_PATTERN}`);
  if (!RELEASE_PATTERN.test(release.release)) {
    issues.push(`release must be a semantic version such as "1.2.3"`);
  }
  if (!ID_PATTERN.test(release.publisher.id)) issues.push(`publisher.id must match ${ID_PATTERN}`);
  if (!DIGEST_PATTERN.test(release.contentDigest)) {
    issues.push('contentDigest must be a sha256 digest');
  }

  const expectedDigest = catalogContentDigest(blueprintContent(release));
  if (release.contentDigest !== expectedDigest) {
    issues.push(`contentDigest mismatch: expected ${expectedDigest}`);
  }

  const trustKey = trustStore.keys.find((key) => key.keyId === release.signature.keyId);
  if (!trustKey) {
    issues.push(`signature key ${JSON.stringify(release.signature.keyId)} is not trusted`);
  } else {
    if (trustKey.revokedAt) {
      issues.push(
        `signature key ${JSON.stringify(trustKey.keyId)} was revoked: ${trustKey.revocationReason || 'no reason provided'}`,
      );
    }
    if (trustKey.publisherId !== release.publisher.id) {
      issues.push(`signature key publisher does not match blueprint publisher`);
    }
    if (trustKey.trustTier !== release.publisher.trustTier) {
      issues.push(`signature key trust tier does not match blueprint trust tier`);
    }
    if (!trustStore.allowedTrustTiers.includes(release.publisher.trustTier)) {
      issues.push(`trust tier ${JSON.stringify(release.publisher.trustTier)} is not allowed`);
    }
    if (release.signature.algorithm !== 'ed25519') {
      issues.push('signature.algorithm must be ed25519');
    } else {
      try {
        const valid = verify(
          null,
          Buffer.from(release.contentDigest, 'utf8'),
          trustKey.publicKeyPem,
          Buffer.from(release.signature.value, 'base64'),
        );
        if (!valid) issues.push('signature does not verify the content digest');
      } catch (error) {
        issues.push(`signature verification failed: ${(error as Error).message}`);
      }
    }
  }

  let normalizedSpec: ValidatedCatalogRelease['normalizedSpec'] | undefined;
  try {
    normalizedSpec = compileApplicationManifest(release.application).spec;
  } catch (error) {
    issues.push((error as Error).message);
  }

  if (normalizedSpec) {
    for (const [name, component] of Object.entries(normalizedSpec.components)) {
      if (!component.image) {
        issues.push(`catalog component ${JSON.stringify(name)} must use a digest-pinned image`);
        continue;
      }
      const match = component.image.match(IMAGE_DIGEST_PATTERN);
      if (!match) {
        issues.push(`component ${JSON.stringify(name)} image must be pinned with @sha256:<digest>`);
        continue;
      }
      const digest = `sha256:${match[1]}`;
      const artifact = release.artifacts.find(
        (candidate) =>
          candidate.kind === 'oci-image' &&
          candidate.reference === component.image &&
          candidate.digest === digest,
      );
      if (!artifact) {
        issues.push(`component ${JSON.stringify(name)} image has no matching OCI artifact record`);
      }
    }

    for (const question of release.questions) {
      const declaration = normalizedSpec.configuration[question.configuration];
      if (!declaration) {
        issues.push(
          `question ${JSON.stringify(question.key)} references unknown configuration ${JSON.stringify(question.configuration)}`,
        );
      } else if (question.secret !== (declaration.type === 'secret')) {
        issues.push(
          `question ${JSON.stringify(question.key)} secret flag does not match declaration`,
        );
      } else if (question.required !== declaration.required) {
        issues.push(
          `question ${JSON.stringify(question.key)} required flag does not match declaration`,
        );
      }
    }
    for (const [name, declaration] of Object.entries(normalizedSpec.configuration)) {
      if (
        declaration.required &&
        !release.questions.some((question) => question.configuration === name)
      ) {
        issues.push(`required configuration ${JSON.stringify(name)} has no setup question`);
      }
    }

    for (const grant of release.security) {
      if (!normalizedSpec.components[grant.component]) {
        issues.push(
          `security grant ${JSON.stringify(grant.id)} references unknown component ${JSON.stringify(grant.component)}`,
        );
      }
    }

    for (const path of release.supportedCustomization) {
      if (!path.startsWith('/'))
        issues.push(`supported customization ${JSON.stringify(path)} must be a JSON Pointer`);
    }

    for (const upgrade of release.upgrades) {
      if (!RELEASE_PATTERN.test(upgrade.fromRelease)) {
        issues.push(`upgrade fromRelease ${JSON.stringify(upgrade.fromRelease)} is invalid`);
      }
      for (const job of upgrade.migrationJobs) {
        if (!normalizedSpec.jobs[job]) {
          issues.push(`upgrade references unknown migration job ${JSON.stringify(job)}`);
        }
      }
    }
  }

  if (release.support.stage === 'blocked' && !release.support.blockedReason) {
    issues.push('blocked releases must include support.blockedReason');
  }
  if (release.support.stage !== 'blocked' && release.support.blockedReason) {
    issues.push('support.blockedReason is only valid for blocked releases');
  }
  if (release.support.stage === 'supported') {
    for (const evidenceKind of ['install', 'restart', 'backup-restore'] as const) {
      if (
        !release.support.evidence.some(
          (item) => item.kind === evidenceKind && item.result === 'passed',
        )
      ) {
        issues.push(`supported releases require passed ${evidenceKind} evidence`);
      }
    }
  }
  if (
    release.support.stage === 'validation' &&
    Object.values(release.compatibility.promises).includes('verified')
  ) {
    issues.push('validation releases cannot claim verified compatibility');
  }

  const artifactIds = new Set<string>();
  for (const artifact of release.artifacts) {
    if (artifactIds.has(artifact.id))
      issues.push(`duplicate artifact id ${JSON.stringify(artifact.id)}`);
    artifactIds.add(artifact.id);
    if (!DIGEST_PATTERN.test(artifact.digest))
      issues.push(`artifact ${artifact.id} has an invalid digest`);
    if (artifact.kind === 'oci-image') {
      const suffix = artifact.reference.match(IMAGE_DIGEST_PATTERN)?.[1];
      if (!suffix || artifact.digest !== `sha256:${suffix}`) {
        issues.push(`OCI artifact ${artifact.id} reference and digest do not match`);
      }
    }
  }

  const evidenceIds = new Set<string>();
  for (const evidence of release.support.evidence) {
    if (evidenceIds.has(evidence.id))
      issues.push(`duplicate evidence id ${JSON.stringify(evidence.id)}`);
    evidenceIds.add(evidence.id);
    if (evidence.result === 'passed' && !evidence.observedAt) {
      issues.push(`passed evidence ${JSON.stringify(evidence.id)} must include observedAt`);
    }
  }

  duplicateIds(release.questions, 'question', issues);
  duplicateIds(release.security, 'security grant', issues);
  const upgradeSources = new Set<string>();
  for (const upgrade of release.upgrades) {
    if (upgradeSources.has(upgrade.fromRelease)) {
      issues.push(`duplicate upgrade source ${JSON.stringify(upgrade.fromRelease)}`);
    }
    upgradeSources.add(upgrade.fromRelease);
  }

  if (issues.length > 0 || !normalizedSpec) throw new CatalogBlueprintError(issues);
  return { release, normalizedSpec };
}

function validateBlueprintShape(input: unknown): string[] {
  const issues: string[] = [];
  const root = shapeRecord(input, '$', issues);
  shapeFields(
    root,
    [
      'schema',
      'id',
      'release',
      'publisher',
      'metadata',
      'support',
      'compatibility',
      'security',
      'artifacts',
      'questions',
      'application',
      'supportedCustomization',
      'upgrades',
      'contentDigest',
      'signature',
    ],
    '$',
    issues,
  );
  shapeString(root.schema, '$.schema', issues);
  shapeString(root.id, '$.id', issues);
  shapeString(root.release, '$.release', issues);
  shapeString(root.contentDigest, '$.contentDigest', issues);

  const publisher = shapeRecord(root.publisher, '$.publisher', issues);
  shapeFields(publisher, ['id', 'name', 'trustTier'], '$.publisher', issues);
  shapeString(publisher.id, '$.publisher.id', issues);
  shapeString(publisher.name, '$.publisher.name', issues);
  shapeEnum(
    publisher.trustTier,
    ['deploy-local', 'community', 'local-private'],
    '$.publisher.trustTier',
    issues,
  );

  const metadata = shapeRecord(root.metadata, '$.metadata', issues);
  shapeFields(
    metadata,
    [
      'name',
      'summary',
      'description',
      'upstreamUrl',
      'supportUrl',
      'license',
      'trademarkNotice',
      'categories',
    ],
    '$.metadata',
    issues,
  );
  for (const field of ['name', 'summary', 'description', 'license']) {
    shapeString(metadata[field], `$.metadata.${field}`, issues);
  }
  shapeStringArray(metadata.categories, '$.metadata.categories', issues);
  for (const field of ['upstreamUrl', 'supportUrl', 'trademarkNotice']) {
    if (metadata[field] !== undefined) shapeString(metadata[field], `$.metadata.${field}`, issues);
  }

  const support = shapeRecord(root.support, '$.support', issues);
  shapeFields(support, ['stage', 'scope', 'blockedReason', 'evidence'], '$.support', issues);
  shapeEnum(
    support.stage,
    ['validation', 'supported', 'deprecated', 'blocked'],
    '$.support.stage',
    issues,
  );
  shapeString(support.scope, '$.support.scope', issues);
  if (support.blockedReason !== undefined) {
    shapeString(support.blockedReason, '$.support.blockedReason', issues);
  }
  const evidence = shapeArray(support.evidence, '$.support.evidence', issues);
  evidence.forEach((item, index) => {
    const path = `$.support.evidence[${index}]`;
    const record = shapeRecord(item, path, issues);
    shapeFields(
      record,
      ['id', 'kind', 'result', 'target', 'summary', 'observedAt', 'reference'],
      path,
      issues,
    );
    for (const field of ['id', 'kind', 'result', 'target', 'summary']) {
      shapeString(record[field], `${path}.${field}`, issues);
    }
    shapeEnum(
      record.kind,
      [
        'schema',
        'signature',
        'install',
        'restart',
        'backup-restore',
        'upgrade-rollback',
        'offline-start',
        'security-review',
      ],
      `${path}.kind`,
      issues,
    );
    shapeEnum(record.result, ['passed', 'failed', 'not-run'], `${path}.result`, issues);
    if (record.observedAt !== undefined)
      shapeString(record.observedAt, `${path}.observedAt`, issues);
    if (record.reference !== undefined) shapeString(record.reference, `${path}.reference`, issues);
  });

  const compatibility = shapeRecord(root.compatibility, '$.compatibility', issues);
  shapeFields(
    compatibility,
    ['deployLocalVersion', 'target', 'promises'],
    '$.compatibility',
    issues,
  );
  shapeString(compatibility.deployLocalVersion, '$.compatibility.deployLocalVersion', issues);
  const target = shapeRecord(compatibility.target, '$.compatibility.target', issues);
  shapeFields(
    target,
    [
      'operatingSystems',
      'architectures',
      'engines',
      'minimumEngineVersion',
      'minimumMemoryMiB',
      'minimumStorageMiB',
      'minimumCpuCores',
      'internetRequiredForInstall',
    ],
    '$.compatibility.target',
    issues,
  );
  for (const field of ['operatingSystems', 'architectures', 'engines']) {
    shapeStringArray(target[field], `$.compatibility.target.${field}`, issues);
  }
  shapeEnumArray(
    target.operatingSystems,
    ['linux', 'darwin', 'windows'],
    '$.compatibility.target.operatingSystems',
    issues,
  );
  shapeEnumArray(
    target.architectures,
    ['amd64', 'arm64'],
    '$.compatibility.target.architectures',
    issues,
  );
  shapeEnumArray(
    target.engines,
    ['docker-engine', 'docker-desktop'],
    '$.compatibility.target.engines',
    issues,
  );
  for (const field of ['minimumMemoryMiB', 'minimumStorageMiB', 'minimumCpuCores']) {
    if (
      typeof target[field] !== 'number' ||
      !Number.isFinite(target[field]) ||
      target[field] <= 0
    ) {
      issues.push(`$.compatibility.target.${field} must be a positive finite number`);
    }
  }
  if (target.minimumEngineVersion !== undefined) {
    shapeString(target.minimumEngineVersion, '$.compatibility.target.minimumEngineVersion', issues);
  }
  if (typeof target.internetRequiredForInstall !== 'boolean') {
    issues.push('$.compatibility.target.internetRequiredForInstall must be a boolean');
  }
  const promises = shapeRecord(compatibility.promises, '$.compatibility.promises', issues);
  shapeFields(
    promises,
    ['install', 'lifecycle', 'offline', 'suitcase', 'reconciliation'],
    '$.compatibility.promises',
    issues,
  );
  for (const field of ['install', 'lifecycle', 'offline', 'suitcase', 'reconciliation']) {
    shapeEnum(
      promises[field],
      ['verified', 'declared', 'not-supported', 'unknown'],
      `$.compatibility.promises.${field}`,
      issues,
    );
  }

  const security = shapeArray(root.security, '$.security', issues);
  security.forEach((item, index) => {
    const path = `$.security[${index}]`;
    const record = shapeRecord(item, path, issues);
    shapeFields(record, ['id', 'kind', 'component', 'required', 'value', 'reason'], path, issues);
    for (const field of ['id', 'kind', 'component', 'reason']) {
      shapeString(record[field], `${path}.${field}`, issues);
    }
    shapeEnum(
      record.kind,
      [
        'privileged-container',
        'host-network',
        'host-path',
        'device',
        'docker-socket',
        'lan-discovery',
      ],
      `${path}.kind`,
      issues,
    );
    if (typeof record.required !== 'boolean') issues.push(`${path}.required must be a boolean`);
    if (record.value !== undefined) shapeString(record.value, `${path}.value`, issues);
  });
  const artifacts = shapeArray(root.artifacts, '$.artifacts', issues);
  artifacts.forEach((item, index) => {
    const path = `$.artifacts[${index}]`;
    const record = shapeRecord(item, path, issues);
    shapeFields(record, ['id', 'kind', 'reference', 'digest', 'verification'], path, issues);
    for (const field of ['id', 'kind', 'reference', 'digest', 'verification']) {
      shapeString(record[field], `${path}.${field}`, issues);
    }
    shapeEnum(record.kind, ['oci-image', 'sbom', 'provenance'], `${path}.kind`, issues);
    shapeEnum(
      record.verification,
      ['resolved', 'unresolved-fixture'],
      `${path}.verification`,
      issues,
    );
  });
  const questions = shapeArray(root.questions, '$.questions', issues);
  questions.forEach((item, index) => {
    const path = `$.questions[${index}]`;
    const record = shapeRecord(item, path, issues);
    shapeFields(
      record,
      ['key', 'configuration', 'label', 'help', 'required', 'secret'],
      path,
      issues,
    );
    for (const field of ['key', 'configuration', 'label']) {
      shapeString(record[field], `${path}.${field}`, issues);
    }
    if (record.help !== undefined) shapeString(record.help, `${path}.help`, issues);
    if (typeof record.required !== 'boolean') issues.push(`${path}.required must be a boolean`);
    if (typeof record.secret !== 'boolean') issues.push(`${path}.secret must be a boolean`);
  });
  shapeRecord(root.application, '$.application', issues);
  shapeStringArray(root.supportedCustomization, '$.supportedCustomization', issues);
  const upgrades = shapeArray(root.upgrades, '$.upgrades', issues);
  upgrades.forEach((item, index) => {
    const path = `$.upgrades[${index}]`;
    const record = shapeRecord(item, path, issues);
    shapeFields(
      record,
      ['fromRelease', 'recoveryPointRequired', 'rollback', 'migrationJobs', 'notes'],
      path,
      issues,
    );
    shapeString(record.fromRelease, `${path}.fromRelease`, issues);
    shapeEnum(
      record.rollback,
      ['supported', 'before-migration-only', 'not-supported'],
      `${path}.rollback`,
      issues,
    );
    shapeString(record.notes, `${path}.notes`, issues);
    shapeStringArray(record.migrationJobs, `${path}.migrationJobs`, issues);
    if (typeof record.recoveryPointRequired !== 'boolean') {
      issues.push(`${path}.recoveryPointRequired must be a boolean`);
    }
  });

  const signature = shapeRecord(root.signature, '$.signature', issues);
  shapeFields(signature, ['algorithm', 'keyId', 'value'], '$.signature', issues);
  shapeEnum(signature.algorithm, ['ed25519'], '$.signature.algorithm', issues);
  shapeString(signature.keyId, '$.signature.keyId', issues);
  shapeString(signature.value, '$.signature.value', issues);
  return issues;
}

function shapeRecord(value: unknown, path: string, issues: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push(`${path} must be an object`);
    return {};
  }
  return value as Record<string, unknown>;
}

function shapeArray(value: unknown, path: string, issues: string[]): unknown[] {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return [];
  }
  return value;
}

function shapeString(value: unknown, path: string, issues: string[]) {
  if (typeof value !== 'string' || value.length === 0)
    issues.push(`${path} must be a non-empty string`);
}

function shapeStringArray(value: unknown, path: string, issues: string[]) {
  const array = shapeArray(value, path, issues);
  if (!array.every((item) => typeof item === 'string'))
    issues.push(`${path} must contain only strings`);
}

function shapeEnum(value: unknown, allowed: readonly string[], path: string, issues: string[]) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    issues.push(`${path} must be one of ${allowed.join(', ')}`);
  }
}

function shapeEnumArray(
  value: unknown,
  allowed: readonly string[],
  path: string,
  issues: string[],
) {
  const array = Array.isArray(value) ? value : [];
  array.forEach((item, index) => shapeEnum(item, allowed, `${path}[${index}]`, issues));
}

function shapeFields(
  value: Record<string, unknown>,
  allowed: string[],
  path: string,
  issues: string[],
) {
  const fields = new Set(allowed);
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) issues.push(`${path} has unknown field ${JSON.stringify(field)}`);
  }
}

function duplicateIds(
  items: Array<{ id?: string; key?: string }>,
  label: string,
  issues: string[],
) {
  const ids = new Set<string>();
  for (const item of items) {
    const id = item.id ?? item.key;
    if (!id) continue;
    if (ids.has(id)) issues.push(`duplicate ${label} id ${JSON.stringify(id)}`);
    ids.add(id);
  }
}

export function compareCatalogRelease(left: string, right: string): number {
  const parse = (value: string) => value.split('-', 1)[0].split('.').map(Number);
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return left.localeCompare(right);
}
