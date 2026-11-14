import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const root = mkdtempSync(join(tmpdir(), 'v2-agent-runs-'));
process.env.DEPLOY_DATA_DIR = root;
await import('../test-ports.ts');
const { db, list, save } = await import('../workspace/store.ts');
const { agentTracking, createAgent } = await import('./agents.ts');
const { taskSnapshot } = await import('./tasks.ts');
const { putAgentControl } = await import('./phone-preferences.ts');
const { answerInbox } = await import('./inbox.ts');
const { runAgentContext } = await import('../workspace/agent-context-store.ts');
const { agentInstructions } = await import('./agent-instructions.ts');
const {
  agentRuns,
  holdScheduleUntilTomorrow,
  scheduledAgentRun,
  startAgentRun,
  tickAgentSchedules,
} = await import('./agent-runs.ts');
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
function agent(owner: string, schedule = { enabled: true, time: '08:00' }) {
  // Runs go to a real worker that takes tasks, as they do on SER.
  save('worker', owner, { id: 'ser', name: 'SER', heartbeat: new Date().toISOString() });
  return createAgent(owner, { name: 'Keeper', job: 'Check the dependencies.', schedule });
}
// createAgent seeds an Ask me rule for every action; change the agent's "Start a task" one.
function rule(owner: string, agentId: string, mode: 'ask' | 'allow' | 'never') {
  const seeded = list('v2-approval', owner).find(
    (row) => row.agent === agentId && row.action === 'start-task',
  );
  save('v2-approval', owner, { ...seeded, mode });
}

test('a run is an ordinary task attributed to the agent, with its job and last report', () => {
  const owner = randomUUID();
  const keeper = agent(owner);
  const task = startAgentRun(owner, keeper, 'manual');
  assert.equal(task.agentId, keeper.id);
  assert.equal(task.workerId, 'ser');
  assert.match(task.title, /^Keeper · run \d{4}-\d{2}-\d{2}$/);
  // Named by the coordinator's own day, not the UTC one.
  const today = new Date();
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  assert.ok(task.title.endsWith(day));
  const run = list('run', owner).find((row) => row.taskId === task.id);
  assert.equal(run.agentId, keeper.id);
  // The job is the agent's setting and reaches the run as instructions; the message only says why.
  assert.equal(
    list('message', owner).find((row) => row.taskId === task.id).content,
    `Run your job now. Started with Run now on ${day}.`,
  );
  assert.match(
    runAgentContext(owner, run).agentContext,
    /operating manual[\s\S]*You are Keeper[\s\S]*Check the dependencies[\s\S]*first run/,
  );
  // A queued run is already the agent's work: it reads Running, and its task names the agent.
  assert.equal(run.status, 'queued');
  assert.equal(agentTracking(owner, keeper.id).runs?.[0].status, 'running');
  assert.equal(agentTracking(owner, keeper.id).running[0].id, task.id);
  assert.deepEqual(taskSnapshot(owner, task.id).agent, { id: keeper.id, name: 'Keeper' });
  // One run at a time; the next sees what the last one reported.
  assert.throws(() => startAgentRun(owner, keeper, 'manual'), /already working/);
  save('run', owner, { ...run, status: 'succeeded' });
  save('message', owner, {
    id: randomUUID(),
    taskId: task.id,
    role: 'assistant',
    content: 'Two patch updates are safe.',
    createdAt: new Date().toISOString(),
  });
  const next = startAgentRun(owner, keeper, 'schedule');
  const nextRun = list('run', owner).find((row) => row.taskId === next.id);
  const context = runAgentContext(owner, nextRun).agentContext;
  assert.match(context, /last run[\s\S]*Two patch updates/);
  // Editing the job in the agent's settings changes the next run's instructions.
  save('agent', owner, { ...keeper, job: 'Check the licenses.' });
  assert.match(runAgentContext(owner, nextRun).agentContext, /Check the licenses/);
  // Tasks you start yourself carry no agent instructions.
  assert.equal(agentInstructions(owner, { createdAt: next.createdAt }), '');
});

test('a scheduled start asks by default, runs when allowed, and skips on Never or pause', () => {
  const owner = randomUUID();
  const keeper = agent(owner);
  const asked = scheduledAgentRun(owner, keeper, '2026-10-29');
  if (!('item' in asked) || !asked.item) throw new Error('Expected a Waiting on you question');
  assert.equal(asked.item.kind, 'other');
  assert.equal(asked.item.from, keeper.id);
  assert.equal(agentRuns(owner, keeper.id).length, 0);
  // Answering Run starts the task; Skip today would leave it.
  answerInbox(owner, asked.item.id, { actionId: 'run', on: 'web' });
  assert.equal(agentRuns(owner, keeper.id).length, 1);

  const other = agent(owner);
  rule(owner, other.id, 'allow');
  const started = scheduledAgentRun(owner, other, '2026-10-29');
  assert.ok('task' in started);
  rule(owner, other.id, 'never');
  assert.deepEqual(scheduledAgentRun(owner, other, '2026-10-30'), { skipped: 'never' });
  rule(owner, other.id, 'allow');
  putAgentControl(owner, other.id, { paused: true });
  assert.deepEqual(scheduledAgentRun(owner, other, '2026-10-30'), { skipped: 'paused' });
});

test('the schedule starts once a day at or after its time, and a new schedule waits a day', () => {
  const owner = randomUUID();
  const keeper = agent(owner);
  // createAgent ran before 08:00 or after it; reset the mark to test the clock alone.
  db.prepare("DELETE FROM records WHERE kind='v2-agent-schedule' AND owner=?").run(owner);
  rule(owner, keeper.id, 'allow');
  tickAgentSchedules(new Date(2026, 9, 29, 7, 59));
  assert.equal(agentRuns(owner, keeper.id).length, 0);
  tickAgentSchedules(new Date(2026, 9, 29, 8, 0));
  assert.equal(agentRuns(owner, keeper.id).length, 1);
  const run = list('run', owner).find((row) => row.taskId === agentRuns(owner, keeper.id)[0].id);
  save('run', owner, { ...run, status: 'succeeded' });
  tickAgentSchedules(new Date(2026, 9, 29, 9, 0));
  assert.equal(agentRuns(owner, keeper.id).length, 1);
  assert.equal(list('v2-agent-schedule', owner)[0].result, 'started');
  tickAgentSchedules(new Date(2026, 9, 30, 8, 5));
  assert.equal(agentRuns(owner, keeper.id).length, 2);

  const late = agent(owner, { enabled: true, time: '08:00' });
  holdScheduleUntilTomorrow(owner, late, new Date(2026, 9, 31, 15, 0));
  rule(owner, late.id, 'allow');
  tickAgentSchedules(new Date(2026, 9, 31, 15, 1));
  assert.equal(agentRuns(owner, late.id).length, 0);
});
