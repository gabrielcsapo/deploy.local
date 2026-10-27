/**
 * A task renders from its own detail. The repository list and the computer inventory arrive with
 * `/state`, which the first load after a coordinator restart can take seconds to answer, and a
 * computer that has not registered again since that restart has a stale heartbeat for a few
 * seconds more. Until each of those lands the answer is unknown — not missing, not offline — so
 * these labels distinguish "we do not know yet" from "it is gone".
 */
export interface TaskComputer {
  id?: string;
  name?: string;
  status?: string;
  capabilities?: string[];
  /** The coordinator restarted and this computer has not reported since; see `computers`. */
  reconnecting?: boolean;
}

/** The repository beside a task. "No project" is only honest once the list has arrived. */
export function taskProjectLabel(
  known: boolean,
  project: { name?: string } | undefined | null,
  projectId?: string | null,
): string {
  if (project?.name) return project.name;
  return projectId && !known ? '' : 'No project';
}

/** The computer beside a task: its name, the id the task names, or that we are still connecting. */
export function taskComputerLabel(
  known: boolean,
  computer: TaskComputer | undefined | null,
  workerId?: string | null,
): string {
  if (computer?.name) return computer.name;
  if (workerId) return workerId;
  return known ? 'Computer unavailable' : 'Reconnecting…';
}

export type TaskComputerNotice = 'reconnecting' | 'offline' | 'provider' | '';

/**
 * What the composer may say about the task computer. An inventory that has not arrived yet and a
 * computer that has not reported since the coordinator restarted are both reconnecting; neither
 * is evidence that the computer is offline.
 */
export function taskComputerNotice(
  known: boolean,
  computer: TaskComputer | undefined | null,
  adapter: string,
): TaskComputerNotice {
  if (!known || computer?.reconnecting) return 'reconnecting';
  if (computer?.status !== 'online') return 'offline';
  if (computer.id !== 'local' && !computer.capabilities?.includes(adapter)) return 'provider';
  return '';
}
