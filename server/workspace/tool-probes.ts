import { get, list, save, now } from './store.ts';
import { probeTool, toolNames } from './worker-capabilities.ts';

/** How long an answer is trusted before the computer is asked again. */
export const staleAfterMs = 10 * 60 * 1000;

/** Answers and unanswered questions survive coordinator restarts and worker disconnects. */
export function toolAnswer(owner: string, workerId: string, tool: string): boolean | null {
  const row = list('tool-probe', owner).find(
    (candidate) => candidate.workerId === workerId && candidate.tool === tool,
  );
  return typeof row?.has === 'boolean' ? row.has : null;
}
export function hasTools(owner: string, workerId: string, tools: string[] = []) {
  return tools.every((tool) => toolAnswer(owner, workerId, tool) === true);
}
export function askTools(owner: string, workerId: string, tools: string[]) {
  for (const tool of toolNames(tools)) {
    const id = `${workerId}:${tool}`;
    const row = list('tool-probe', owner).find((candidate) => candidate.id === id);
    if (!row) save('tool-probe', owner, { id, workerId, tool, has: null, askedAt: now() });
    // An answer goes stale: programs get installed and removed. Ask again, keeping the last
    // answer in the meantime so an offline computer is still judged on what it last said.
    else if (
      row.answeredAt &&
      Date.parse(now()) - Date.parse(row.answeredAt) > staleAfterMs &&
      !row.recheck
    )
      save('tool-probe', owner, { ...row, recheck: true, askedAt: now() });
  }
}
export function pendingToolProbes(owner: string, workerId: string) {
  return list('tool-probe', owner)
    .filter((row) => row.workerId === workerId && (row.has === null || row.recheck))
    .slice(0, 100)
    .map((row) => row.tool);
}
export function recordToolAnswers(owner: string, workerId: string, answers: unknown) {
  if (answers === undefined) return;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers))
    throw new Error('Invalid tool answers');
  toolNames(Object.keys(answers));
  for (const [tool, has] of Object.entries(answers)) {
    if (typeof has !== 'boolean') throw new Error('Invalid tool answer');
    const row = get('tool-probe', owner, `${workerId}:${tool}`);
    // Only answers to this computer's outstanding questions are accepted.
    if (row.has === null || row.recheck)
      save('tool-probe', owner, { ...row, has, recheck: false, answeredAt: now() });
  }
}
const probing = new Map<string, Promise<void>>();
export async function answerLocalTools(owner: string) {
  await Promise.all(
    pendingToolProbes(owner, 'local').map(async (tool) => {
      const key = `${owner}:${tool}`;
      let pending = probing.get(key);
      if (!pending) {
        pending = probeTool(tool)
          .then((has) => {
            recordToolAnswers(owner, 'local', { [tool]: has });
          })
          .finally(() => {
            probing.delete(key);
          });
        probing.set(key, pending);
      }
      await pending;
    }),
  );
}
