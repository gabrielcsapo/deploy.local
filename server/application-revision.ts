import { stringify } from 'yaml';
import {
  compileApplicationManifest,
  renderRepositoryDeployYaml,
  type ApplicationSpec,
} from './application-spec.ts';

const ABSENT = Symbol('absent');
type MaybeValue = unknown | typeof ABSENT;

export interface ApplicationRevisionRebase {
  conflicts: string[];
  spec?: ApplicationSpec;
  digest?: `sha256:${string}`;
  manifest?: string;
}

export class RepositoryRevisionConflictError extends Error {
  readonly currentDigest: string | null;
  readonly declaredBaseDigest: string | null;
  readonly choices = ['rebase', 'replace', 'cancel'] as const;

  constructor(currentDigest: string | null, declaredBaseDigest: string | null) {
    super(
      currentDigest
        ? 'Repository deploy.yaml is not based on the current desired revision; choose rebase, explicit replace, or cancel'
        : 'Repository deploy.yaml declares a base for an application that does not exist',
    );
    this.name = 'RepositoryRevisionConflictError';
    this.currentDigest = currentDigest;
    this.declaredBaseDigest = declaredBaseDigest;
  }
}

export function admitRepositoryRevision(input: {
  currentDigest: string | null;
  candidateDigest: string;
  declaredBaseDigest: string | null;
  resolution?: string | null;
}): { unchanged: boolean; replaced: boolean } {
  if (input.candidateDigest === input.currentDigest) {
    return { unchanged: true, replaced: false };
  }
  if (!input.currentDigest && !input.declaredBaseDigest) {
    return { unchanged: false, replaced: false };
  }
  if (input.currentDigest && input.declaredBaseDigest === input.currentDigest) {
    return { unchanged: false, replaced: false };
  }
  if (input.currentDigest && input.resolution === 'replace') {
    return { unchanged: false, replaced: true };
  }
  throw new RepositoryRevisionConflictError(input.currentDigest, input.declaredBaseDigest);
}

export function repositoryUploadCanSkipRuntime(input: {
  revisionUnchanged: boolean;
  desiredDigest: string | null;
  activeDigest: string | null;
  previousSourceArtifactDigest: string | null;
  nextSourceArtifactDigest: string;
}) {
  if (!input.revisionUnchanged) return false;
  const alignsAnUnactivatedDesiredRevision = Boolean(
    input.desiredDigest && input.activeDigest && input.desiredDigest !== input.activeDigest,
  );
  const sourceIsKnownAndChanged = Boolean(
    input.previousSourceArtifactDigest &&
    input.previousSourceArtifactDigest !== input.nextSourceArtifactDigest,
  );
  return alignsAnUnactivatedDesiredRevision || !sourceIsKnownAndChanged;
}

/**
 * Replay the repository's semantic changes from `base` onto `current`.
 * Independent map edits merge; overlapping scalar/array/removal edits are
 * reported and never guessed.
 */
export function rebaseApplicationRevision(input: {
  base: ApplicationSpec;
  current: ApplicationSpec;
  repository: ApplicationSpec;
  currentDigest: string;
}): ApplicationRevisionRebase {
  const conflicts: string[] = [];
  const merged = mergeValue(input.base, input.current, input.repository, [], conflicts);
  if (conflicts.length > 0 || merged === ABSENT || !isRecord(merged)) {
    return { conflicts: [...new Set(conflicts)].sort() };
  }
  const compiled = compileApplicationManifest(merged as unknown as ApplicationSpec);
  return {
    conflicts: [],
    spec: compiled.spec,
    digest: compiled.digest,
    manifest: renderRepositoryDeployYaml(compiled.spec, input.currentDigest),
  };
}

/** A reviewable RFC-7396-style patch anchored to one immutable parent digest. */
export function renderParentRelativeApplicationPatch(input: {
  applicationName: string;
  parentDigest: string | null;
  targetDigest: string;
  parent: ApplicationSpec | null;
  target: ApplicationSpec;
}): string {
  const patch = mergePatch(input.parent ?? {}, input.target);
  return stringify(
    {
      apiVersion: 'deploy.local/v1',
      kind: 'ApplicationPatch',
      metadata: {
        application: input.applicationName,
        parentDigest: input.parentDigest,
        targetDigest: input.targetDigest,
      },
      patch,
    },
    { lineWidth: 0, sortMapEntries: true },
  );
}

function mergeValue(
  base: MaybeValue,
  current: MaybeValue,
  repository: MaybeValue,
  path: string[],
  conflicts: string[],
): MaybeValue {
  if (same(repository, base)) return cloneMaybe(current);
  if (same(current, base) || same(current, repository)) return cloneMaybe(repository);

  if (isRecord(base) && isRecord(current) && isRecord(repository)) {
    const result: Record<string, unknown> = {};
    const keys = new Set([
      ...Object.keys(base),
      ...Object.keys(current),
      ...Object.keys(repository),
    ]);
    for (const key of [...keys].sort()) {
      const value = mergeValue(
        Object.hasOwn(base, key) ? base[key] : ABSENT,
        Object.hasOwn(current, key) ? current[key] : ABSENT,
        Object.hasOwn(repository, key) ? repository[key] : ABSENT,
        [...path, key],
        conflicts,
      );
      if (value !== ABSENT) result[key] = value;
    }
    return result;
  }

  conflicts.push(pointer(path));
  return cloneMaybe(current);
}

function mergePatch(before: unknown, after: unknown): unknown {
  if (same(before, after)) return {};
  if (!isRecord(before) || !isRecord(after)) return structuredClone(after);
  const result: Record<string, unknown> = {};
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (!Object.hasOwn(after, key)) {
      result[key] = null;
      continue;
    }
    if (!Object.hasOwn(before, key)) {
      result[key] = structuredClone(after[key]);
      continue;
    }
    if (!same(before[key], after[key])) result[key] = mergePatch(before[key], after[key]);
  }
  return result;
}

function cloneMaybe(value: MaybeValue): MaybeValue {
  return value === ABSENT ? ABSENT : structuredClone(value);
}

function same(left: MaybeValue, right: MaybeValue): boolean {
  if (left === ABSENT || right === ABSENT) return left === right;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pointer(path: string[]): string {
  if (path.length === 0) return '/';
  return `/${path.map((value) => value.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
}
