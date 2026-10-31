import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ReleaseNodePayload } from './releases-worker.ts';
const root = mkdtempSync(join(tmpdir(), 'release-dispatch-'));
process.env.DEPLOY_DATA_DIR = root;
const { dispatchReleaseNodeJob } = await import('./releases-remote.ts');
const { ensureCoordinatorNode, getSqlite, getAgentJob, completeAgentJob, _resetDb } =
  await import('../store.ts');
after(() => {
  _resetDb();
  rmSync(root, { recursive: true, force: true });
});
ensureCoordinatorNode();

// Plays the agent: waits for the job to be queued, claims it, then finishes it.
async function agentFinishes(phase: string, success: boolean) {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
    const row = getSqlite()!
      .prepare(
        "SELECT id FROM agent_jobs WHERE type='project-release' AND status='queued' ORDER BY created_at DESC",
      )
      .get() as { id: string } | undefined;
    if (row && JSON.parse(getAgentJob(row.id)!.payload).phase === phase) {
      getSqlite()!.prepare("UPDATE agent_jobs SET status='running' WHERE id=?").run(row.id);
      completeAgentJob(
        row.id,
        'coordinator',
        success
          ? { success, result: { phase: 'aborted', verified: false } }
          : { success, error: 'Unsupported job: project-release' },
      );
      return row.id;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`No queued ${phase} job`);
}

const payload = (phase: string) =>
  ({ phase, releaseId: 'release-1', application: 'forma' }) as unknown as ReleaseNodePayload;

test('recovery runs a failed abort again instead of replaying its failure', async () => {
  const first = dispatchReleaseNodeJob('coordinator', 'forma', payload('abort'));
  const id = await agentFinishes('abort', false);
  await assert.rejects(first, /Unsupported job/);
  // A newer agent can now run it: the same durable job is queued again with its payload.
  const retry = dispatchReleaseNodeJob('coordinator', 'forma', payload('abort'));
  assert.equal(await agentFinishes('abort', true), id);
  assert.deepEqual(await retry, { phase: 'aborted', verified: false });
});

test('a failed Verify stays failed for the same release', async () => {
  const first = dispatchReleaseNodeJob('coordinator', 'forma', payload('verify'));
  await agentFinishes('verify', false);
  await assert.rejects(first, /Unsupported job/);
  await assert.rejects(
    dispatchReleaseNodeJob('coordinator', 'forma', payload('verify')),
    /Unsupported job/,
  );
});
