import type { Computer } from '../../../server/computer-roles';

export function computerCredentials(computer: Computer) {
  return [
    ...(computer.nodeId ? ['execution agent credential'] : []),
    ...(computer.workerIds.length ? ['task worker credential'] : []),
  ].join(' and ');
}

/** Try every credential even if one endpoint fails, and report partial failures. */
export async function removeComputer(
  computer: Computer,
  request: (url: string, method: string, body?: unknown) => Promise<unknown>,
) {
  if (computer.roles.coordinator) throw new Error('The coordinator cannot be removed.');
  const results = await Promise.allSettled([
    ...(computer.nodeId
      ? [request(`/api/nodes/${encodeURIComponent(computer.nodeId)}`, 'DELETE')]
      : []),
    ...computer.workerIds.map((id) =>
      request(`/api/workspace/computers/${encodeURIComponent(id)}/revoke`, 'POST', {
        operationId: crypto.randomUUID(),
      }),
    ),
  ]);
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length)
    throw new Error(failures.map((failure) => String(failure.reason)).join(' · '));
}
