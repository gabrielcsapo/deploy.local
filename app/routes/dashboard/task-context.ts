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

/**
 * The two reads a task's context comes from, each of which can still be in flight. The task's own
 * project and computer ids come from its detail; the names behind them, and whether that computer
 * is online, come from `/state`. A deep link paints before either has answered, so both have to
 * be asked about separately rather than collapsed into one "loaded" flag.
 */
export interface TaskContextKnown {
  /** The open task's detail has arrived, so which project and computer it names is known. */
  task: boolean;
  /** `/state` has answered, so the repository list and the computer inventory are known. */
  inventory: boolean;
}

/**
 * The repository beside a task. "No project" is only honest once the list has arrived; until then
 * the label is empty, which every view renders as a placeholder rather than as a claim.
 */
export function taskProjectLabel(
  known: TaskContextKnown,
  project: { name?: string } | undefined | null,
  projectId?: string | null,
): string {
  if (!known.task) return '';
  if (project?.name) return project.name;
  return projectId && !known.inventory ? '' : 'No project';
}

/**
 * The computer beside a task: its name, the id the task names, or that we are still connecting.
 * Empty until the task's detail says which computer that is.
 */
export function taskComputerLabel(
  known: TaskContextKnown,
  computer: TaskComputer | undefined | null,
  workerId?: string | null,
): string {
  if (!known.task) return '';
  if (computer?.name) return computer.name;
  if (workerId) return workerId;
  return known.inventory ? 'Computer unavailable' : 'Reconnecting…';
}

export type TaskComputerNotice = 'reconnecting' | 'offline' | 'provider' | '';

/**
 * What the composer may say about the task computer. Before the task's detail arrives there is no
 * computer to say anything about, so it says nothing. After that, an inventory that has not
 * arrived yet and a computer that has not reported since the coordinator restarted are both
 * reconnecting; neither is evidence that the computer is offline.
 */
export function taskComputerNotice(
  known: TaskContextKnown,
  computer: TaskComputer | undefined | null,
  adapter: string,
): TaskComputerNotice {
  if (!known.task) return '';
  if (!known.inventory || computer?.reconnecting) return 'reconnecting';
  if (computer?.status !== 'online') return 'offline';
  if (computer.id !== 'local' && !computer.capabilities?.includes(adapter)) return 'provider';
  return '';
}
