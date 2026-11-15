import type { ApplicationSpec } from '../../application-spec.ts';

/**
 * External bind resources that every component mounts read-only, like a media
 * library on a NAS. Verify mounts the same host path into its copy instead of
 * copying it, which is safe because no copy can write to it, and the
 * pre-release backup leaves it out because it isn't the project's data.
 */
export function sharedReadOnlyResources(spec: ApplicationSpec): Set<string> {
  const shared = new Set<string>();
  for (const [name, resource] of Object.entries(spec.resources)) {
    if (resource.ownership !== 'external' || resource.source?.type !== 'bind') continue;
    const mounts = Object.values(spec.components).flatMap((component) =>
      Object.values(component.mounts).filter((mount) => mount.resource === name),
    );
    if (mounts.every((mount) => mount.readOnly)) shared.add(name);
  }
  return shared;
}

/** Resources Verify would have to copy but cannot: external or bound data that isn't shared read-only. */
export function uncopyableResources(spec: ApplicationSpec): string[] {
  const shared = sharedReadOnlyResources(spec);
  return Object.entries(spec.resources)
    .filter(
      ([name, resource]) =>
        !shared.has(name) && (resource.source || resource.ownership === 'external'),
    )
    .map(([name]) => name);
}
