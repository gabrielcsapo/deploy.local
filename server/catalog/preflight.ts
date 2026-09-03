import { compileApplicationManifest, type ApplicationSpec } from '../application-spec.ts';
import type {
  CatalogPreflightFinding,
  CatalogPreflightResult,
  CatalogSecurityGrant,
  CatalogTargetProfile,
  ValidatedCatalogRelease,
} from './types.ts';

export interface CatalogPreflightInput {
  release: ValidatedCatalogRelease;
  applicationName: string;
  target: CatalogTargetProfile;
  answers?: Record<string, unknown>;
}

export function preflightCatalogInstall(input: CatalogPreflightInput): CatalogPreflightResult {
  const { release, target } = input;
  const findings: CatalogPreflightFinding[] = [];
  const constraints = release.release.compatibility.target;

  if (!target.capabilities.catalogExecution) {
    findings.push(
      blocking(
        'target-catalog-execution-unsupported',
        'target',
        `Catalog execution on ${target.siteId} cannot report terminal completion to this coordinator.`,
        'Choose Home or a paired suitcase target with authenticated catalog completion support.',
      ),
    );
  }

  if (target.siteKind === 'suitcase') {
    const suitcasePromise = release.release.compatibility.promises.suitcase;
    if (suitcasePromise === 'not-supported') {
      findings.push(
        blocking(
          'release-suitcase-not-supported',
          'suitcase',
          `${release.release.metadata.name} does not support suitcase deployment in this release.`,
          'Choose Home or a blueprint release with declared or verified suitcase support.',
        ),
      );
    } else if (suitcasePromise === 'unknown') {
      findings.push({
        id: 'release-suitcase-evidence-unknown',
        dimension: 'suitcase',
        severity: 'warning',
        summary:
          'Suitcase departure, offline startup, and rejoin checks have not been run for this release.',
        remediation:
          'Validate departure, offline startup, and rejoin before relying on this application.',
      });
    }
  }

  if (
    !versionSatisfiesRange(
      target.deployLocalVersion,
      release.release.compatibility.deployLocalVersion,
    )
  ) {
    findings.push(
      blocking(
        'target-deploy-local-version',
        'target',
        `deploy.local ${target.deployLocalVersion} is outside required range ${release.release.compatibility.deployLocalVersion}.`,
        'Upgrade deploy.local or choose a compatible blueprint release.',
      ),
    );
  }

  if (release.release.support.stage === 'validation') {
    findings.push({
      id: 'release-validation-evidence-incomplete',
      dimension: 'release',
      severity: 'warning',
      summary:
        'The required physical install, restart, and backup/restore checks have not all passed.',
      remediation:
        'Use the explicit lifecycle check results below; a not-run check is never treated as passed.',
    });
  } else if (release.release.support.stage === 'blocked') {
    findings.push(
      blocking(
        'release-blocked',
        'release',
        release.release.support.blockedReason || 'This catalog release is blocked.',
      ),
    );
  } else if (release.release.support.stage === 'deprecated') {
    findings.push({
      id: 'release-deprecated',
      dimension: 'release',
      severity: 'warning',
      summary: 'This release is deprecated. Existing installations may keep running.',
      remediation: 'Select a maintained release when an upgrade path is available.',
    });
  }

  if (!constraints.operatingSystems.includes(target.operatingSystem)) {
    findings.push(
      blocking(
        'target-operating-system',
        'target',
        `${target.operatingSystem} is outside this release's operating-system matrix.`,
      ),
    );
  }
  if (!constraints.architectures.includes(target.architecture)) {
    findings.push(
      blocking(
        'target-architecture',
        'target',
        `${target.architecture} is outside this release's architecture matrix.`,
      ),
    );
  }
  if (!constraints.engines.includes(target.engine)) {
    findings.push(
      blocking(
        'target-container-engine',
        'target',
        `${target.engine} is outside this release's container-engine matrix.`,
      ),
    );
  }
  if (
    constraints.minimumEngineVersion &&
    compareVersion(target.engineVersion, constraints.minimumEngineVersion) < 0
  ) {
    findings.push(
      blocking(
        'target-engine-version',
        'target',
        `Container engine ${target.engineVersion} is older than required ${constraints.minimumEngineVersion}.`,
        'Upgrade the selected target container engine.',
      ),
    );
  }

  capacityFinding(findings, 'memory', target.memoryMiB, constraints.minimumMemoryMiB, 'MiB memory');
  capacityFinding(
    findings,
    'storage',
    target.storageMiB,
    constraints.minimumStorageMiB,
    'MiB storage',
  );
  capacityFinding(findings, 'cpu', target.cpuCores, constraints.minimumCpuCores, 'CPU cores');

  for (const artifact of release.release.artifacts) {
    if (artifact.verification !== 'resolved') {
      findings.push(
        blocking(
          `artifact-${artifact.id}-unresolved`,
          'artifact',
          `${artifact.id} uses an unresolved validation-fixture digest.`,
          'Resolve the upstream artifact and issue a new signed blueprint release.',
        ),
      );
    }
    if (!target.online && !target.cachedArtifactDigests.includes(artifact.digest)) {
      findings.push(
        blocking(
          `artifact-${artifact.id}-offline`,
          'offline',
          `${artifact.id} is not cached on offline target ${target.siteId}.`,
          'Materialize every pinned artifact while the target is connected.',
        ),
      );
    }
  }

  for (const grant of release.release.security) {
    const finding = securityFinding(grant, target);
    if (finding) findings.push(finding);
    else {
      findings.push({
        id: `security-${grant.id}-available`,
        dimension: 'security',
        severity: 'info',
        summary: `${grant.kind} capability is available on ${target.siteId}; administrator approval is still required.`,
      });
    }
  }

  const answerState: CatalogPreflightResult['answerState'] = {};
  const answers = input.answers ?? {};
  for (const question of release.release.questions) {
    const declaration = release.normalizedSpec.configuration[question.configuration];
    const answer = answers[question.key];
    const configured = answer !== undefined || declaration.default !== undefined;
    answerState[question.key] = {
      configured,
      secret: question.secret,
      ...(!question.secret && answer !== undefined
        ? { displayValue: validateAnswer(question.key, declaration, answer, findings) }
        : {}),
    };
    if (question.secret && answer !== undefined) {
      validateAnswer(question.key, declaration, answer, findings);
    }
    if (question.required && !configured) {
      findings.push(
        blocking(
          `configuration-${question.key}-missing`,
          'configuration',
          `${question.label} is required before an install plan can be admitted.`,
        ),
      );
    }
  }

  let normalizedSpec: ApplicationSpec;
  try {
    normalizedSpec = compileApplicationManifest({
      ...release.normalizedSpec,
      metadata: { ...release.normalizedSpec.metadata, name: input.applicationName },
    }).spec;
  } catch (error) {
    findings.push(
      blocking(
        'configuration-application-name',
        'configuration',
        (error as Error).message,
        'Choose a lowercase application name beginning with a letter.',
      ),
    );
    normalizedSpec = release.normalizedSpec;
  }

  return {
    blueprintId: release.release.id,
    release: release.release.release,
    siteId: target.siteId,
    ready: !findings.some((finding) => finding.severity === 'blocking'),
    findings,
    answerState,
    normalizedSpec,
  };
}

function securityFinding(
  grant: CatalogSecurityGrant,
  target: CatalogTargetProfile,
): CatalogPreflightFinding | undefined {
  let available = false;
  if (grant.kind === 'privileged-container') available = target.capabilities.privilegedContainers;
  else if (grant.kind === 'host-network') available = target.capabilities.hostNetwork;
  else if (grant.kind === 'lan-discovery') available = target.capabilities.lanDiscovery;
  else if (grant.kind === 'docker-socket') available = target.capabilities.dockerSocket;
  else if (grant.kind === 'host-path') {
    available = Boolean(grant.value && target.capabilities.hostPaths.includes(grant.value));
  } else if (grant.kind === 'device') {
    available = Boolean(
      grant.value &&
      target.capabilities.devices.some((device) =>
        grant.value!.endsWith('*')
          ? device.startsWith(grant.value!.slice(0, -1))
          : device === grant.value,
      ),
    );
  }
  if (available) return undefined;
  return {
    id: `security-${grant.id}-unavailable`,
    dimension: 'security',
    severity: grant.required ? 'blocking' : 'warning',
    summary: `${grant.kind} capability is not available on ${target.siteId}: ${grant.reason}`,
    remediation: grant.required
      ? 'Select a target that exposes this capability or choose another release.'
      : 'Leave this optional integration disabled.',
  };
}

function validateAnswer(
  key: string,
  declaration: ApplicationSpec['configuration'][string],
  answer: unknown,
  findings: CatalogPreflightFinding[],
): string | number | boolean | undefined {
  const validType =
    ((declaration.type === 'string' ||
      declaration.type === 'secret' ||
      declaration.type === 'file' ||
      declaration.type === 'enum') &&
      typeof answer === 'string') ||
    (declaration.type === 'url' && typeof answer === 'string' && isAbsoluteUrl(answer)) ||
    (declaration.type === 'number' && typeof answer === 'number' && Number.isFinite(answer)) ||
    (declaration.type === 'integer' &&
      typeof answer === 'number' &&
      Number.isSafeInteger(answer)) ||
    (declaration.type === 'boolean' && typeof answer === 'boolean');
  const allowed =
    !declaration.allowedValues ||
    declaration.allowedValues.some((value) => Object.is(value, answer));
  if (!validType || !allowed) {
    findings.push(
      blocking(
        `configuration-${key}-invalid`,
        'configuration',
        `${key} does not match its ${declaration.type} declaration${allowed ? '' : ' or allowed values'}.`,
      ),
    );
    return undefined;
  }
  return declaration.type === 'secret' ? undefined : (answer as string | number | boolean);
}

function isAbsoluteUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return Boolean(parsed.protocol && parsed.hostname);
  } catch {
    return false;
  }
}

function capacityFinding(
  findings: CatalogPreflightFinding[],
  id: string,
  available: number,
  required: number,
  unit: string,
) {
  if (available >= required) return;
  findings.push(
    blocking(
      `capacity-${id}`,
      'capacity',
      `Target provides ${available} ${unit}; this release declares at least ${required}.`,
      'Choose a larger target or a smaller application release.',
    ),
  );
}

function blocking(
  id: string,
  dimension: CatalogPreflightFinding['dimension'],
  summary: string,
  remediation?: string,
): CatalogPreflightFinding {
  return { id, dimension, severity: 'blocking', summary, remediation };
}

function compareVersion(left: string, right: string): number {
  const parse = (value: string) => value.split(/[.+-]/).slice(0, 3).map(Number);
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function versionSatisfiesRange(version: string, range: string): boolean {
  return range.split(/\s+/).every((constraint) => {
    const match = constraint.match(/^(>=|>|<=|<|=)?(\d+(?:\.\d+){0,2})$/);
    if (!match) return false;
    const comparison = compareVersion(version, match[2]);
    if (match[1] === '>=') return comparison >= 0;
    if (match[1] === '>') return comparison > 0;
    if (match[1] === '<=') return comparison <= 0;
    if (match[1] === '<') return comparison < 0;
    return comparison === 0;
  });
}
