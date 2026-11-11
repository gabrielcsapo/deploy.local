import { computers } from '../workspace/coordination.ts';
import { getComputers } from './computers.ts';

/**
 * A worker that can take a task the server starts by itself: on one of the named computers when
 * any are named, otherwise on any online computer that takes tasks, SER first, preferring one with
 * the provider connected. Workers only claim runs addressed to them, so a task queued without a
 * real worker waits forever.
 */
export function onlineTaskWorker(
  owner: string,
  options: { adapter?: string; wanted?: string[] } = {},
): string | undefined {
  const adapter = options.adapter ?? 'codex';
  const wanted = (options.wanted ?? []).map((value) => value.toLowerCase());
  const workers = new Map(
    computers(owner)
      .filter((worker) => worker.status === 'online')
      .map((worker) => [worker.id, worker as any]),
  );
  const ready = getComputers(owner)
    .filter((computer) => computer.online && computer.roles.includes('take-tasks'))
    .filter(
      (computer) =>
        !wanted.length ||
        wanted.includes(computer.id.toLowerCase()) ||
        wanted.includes(computer.name.toLowerCase()),
    )
    .sort((a, b) => Number(b.id === 'coordinator') - Number(a.id === 'coordinator'))
    .flatMap((computer) => computer.workerIds.filter((id) => workers.has(id)));
  const connected = ready.find((id) =>
    workers
      .get(id)
      .connections?.some((value: any) => value.provider === adapter && value.available),
  );
  return connected ?? ready[0];
}
