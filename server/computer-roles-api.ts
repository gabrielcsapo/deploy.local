import { parseWantedRoles, switchableRoles } from './computer-roles.ts';
import { setComputerRolePreferences } from './store.ts';
import { allComputerRoles } from './workspace/coordination.ts';

/** Called only after the fleet owner has been authenticated by the API. */
export function patchComputerRoles(owner: string, id: string, body: unknown) {
  const computer = allComputerRoles(owner).find((candidate) => candidate.id === id);
  if (!computer) throw Object.assign(new Error('Unknown computer'), { status: 404 });
  const patch = parseWantedRoles(body);
  const defaults = Object.fromEntries(
    switchableRoles.map((role) => [role, computer.roles[role].state !== 'off']),
  );
  setComputerRolePreferences(computer.id, { ...defaults, ...patch });
  return { computer: allComputerRoles(owner).find((candidate) => candidate.id === computer.id) };
}
