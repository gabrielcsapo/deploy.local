/** Resolve an authenticated coordinator job to one safe Docker container argument. */
export function resolveAgentContainerName(
  deploymentName: string,
  containerNameOverride?: unknown,
): string {
  if (containerNameOverride !== undefined) {
    if (
      typeof containerNameOverride !== 'string' ||
      !/^deploy-sh-[a-z0-9_.-]+$/.test(containerNameOverride)
    ) {
      throw new Error('Agent container override is invalid');
    }
    return containerNameOverride;
  }
  return `deploy-sh-${deploymentName.toLowerCase()}`;
}
