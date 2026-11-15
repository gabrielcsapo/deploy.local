import type { Release, ReleasePart } from '../../../shared/v2/contracts.ts';

export type WorkerReleasePart = Omit<ReleasePart, 'app'>;

export function parseReleaseParts(value: unknown): WorkerReleasePart[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error('Invalid release parts');
  const timestamp = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' &&
    Number.isFinite(Date.parse(candidate)) &&
    new Date(candidate).toISOString() === candidate;
  return value.map((part) => {
    if (
      !part ||
      !['copy data', 'build image', 'start', 'wait for health'].includes(part.name) ||
      !timestamp(part.startedAt) ||
      (part.endedAt !== undefined && (!timestamp(part.endedAt) || part.endedAt < part.startedAt))
    )
      throw new Error('Invalid release part');
    return {
      name: part.name,
      startedAt: part.startedAt,
      ...(part.endedAt === undefined ? {} : { endedAt: part.endedAt }),
    };
  });
}

// Observers are scoped to a plan object, never serialized with its durable runtime receipt.
const observers = new WeakMap<object, (key: string, parts: ReleasePart[]) => void>();
const emptyResourceObservers = new WeakMap<
  object,
  (resources: NonNullable<Release['steps'][number]['verifyEmptyResources']>) => void
>();
export function reportVerifyEmptyResources(
  plan: object,
  resources: NonNullable<Release['steps'][number]['verifyEmptyResources']>,
) {
  emptyResourceObservers.get(plan)?.(resources);
}
export function reportReleaseParts(plan: object, key: string, parts: ReleasePart[]) {
  observers.get(plan)?.(key, parts);
}
export function observeReleaseParts(
  plan: object | object[],
  step: Release['steps'][number],
  persist: () => void,
) {
  const jobs = new Map<string, ReleasePart[]>();
  const previous = step.parts ?? [];
  const observer = (key: string, parts: ReleasePart[]) => {
    if (step.state !== 'running') return;
    if (JSON.stringify(jobs.get(key)) === JSON.stringify(parts)) return;
    jobs.set(key, structuredClone(parts));
    step.parts = [...previous, ...[...jobs.values()].flat()];
    persist();
  };
  for (const target of Array.isArray(plan) ? plan : [plan]) {
    observers.set(target, observer);
    emptyResourceObservers.set(target, (resources) => {
      if (step.name !== 'verify' || step.state !== 'running') return;
      step.verifyEmptyResources = structuredClone(resources);
      persist();
    });
  }
}

/** End timestamps describe the operation boundary even when the operation throws. */
export async function timeReleasePart<Name extends WorkerReleasePart['name'], T>(
  onPart: ((name: Name, state: 'start' | 'end') => void) | undefined,
  name: Name,
  run: () => Promise<T>,
): Promise<T> {
  onPart?.(name, 'start');
  try {
    return await run();
  } finally {
    onPart?.(name, 'end');
  }
}
