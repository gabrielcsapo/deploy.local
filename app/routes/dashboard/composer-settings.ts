export interface RunSettings {
  id: string;
  adapter: string;
  model?: string | null;
  effort?: string | null;
}

export interface ComposerSettings {
  adapter: string;
  model: string;
  effort: string;
}

/**
 * The composer follows the task's latest run: opening a task, and each new run (from any device),
 * shows the adapter, model and effort that run used. `adopted` is the `<taskId>:<runId>` already
 * applied, so polling and a run finishing never replace what the person picked since. Returns the
 * settings to apply and the new marker, or null to keep the composer as it is (no runs yet: the
 * composer keeps the computer's default or what was chosen for the first message).
 */
export function latestRunSettings(
  taskId: string,
  runs: readonly RunSettings[] | null | undefined,
  adopted: string,
): { settings: ComposerSettings; adopted: string } | null {
  const last = runs?.at(-1);
  if (!taskId || !last) return null;
  const marker = `${taskId}:${last.id}`;
  if (marker === adopted) return null;
  return {
    settings: { adapter: last.adapter, model: last.model || '', effort: last.effort || '' },
    adopted: marker,
  };
}

/**
 * An effort the computer does not list for the chosen model is cleared, but only once the computer
 * has said what it supports: an offline or still-loading computer must not erase the task's effort.
 */
export function supportedEffort(effort: string, efforts: readonly string[]): string {
  return efforts.length && !efforts.includes(effort) ? '' : effort;
}
