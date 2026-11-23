import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ReleaseNodePayload } from '../../v2/releases-worker.ts';
const root = mkdtempSync(join(tmpdir(), 'release-dispatch-'));
process.env.DEPLOY_DATA_DIR = root;
const { dispatchReleaseNodeJob } = await import('./releases-remote.ts');
const { ensureCoordinatorNode, getSqlite, getAgentJob, completeAgentJob, _resetDb } =
  await import('../../store.ts');
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

const { createReleaseNodeTransport } = await import('./releases-remote.ts');
const { recordReleaseJobProgress, claimAgentJob, enqueueAgentJob } = await import('../../store.ts');
const minute = 60_000;
const timeoutMessage =
  'Computer release job has not completed; recovery will follow its durable receipt';

for (const scenario of [
  {
    name: 'regular progress lets Verify run for 66 minutes',
    mode: 'progress',
    end: 66 * minute,
    success: true,
  },
  {
    name: 'ten minutes without progress requires recovery',
    mode: 'stalled',
    end: 10 * minute,
    success: false,
  },
  {
    name: 'an unclaimed job still fails after twenty minutes',
    mode: 'unclaimed',
    end: 20 * minute,
    success: false,
  },
  {
    name: 'an old worker without progress keeps twenty minutes',
    mode: 'old',
    end: 20 * minute,
    success: false,
  },
  {
    name: 'even continuous progress stops at the three-hour cap',
    mode: 'progress',
    end: 180 * minute,
    success: false,
  },
]) {
  test(scenario.name, async (t) => {
    const start = 1_800_000_000_000;
    t.mock.timers.enable({ apis: ['Date'], now: start });
    const application = scenario.mode + scenario.end;
    let jobId = '';
    const transport = createReleaseNodeTransport({
      now: Date.now,
      sleep: async () => {
        const row = getSqlite()!
          .prepare('SELECT id FROM agent_jobs WHERE deployment_name=?')
          .get(application) as { id: string };
        jobId = row.id;
        if (scenario.mode !== 'unclaimed' && getAgentJob(jobId)!.status === 'queued') {
          getSqlite()!
            .prepare("UPDATE agent_jobs SET status='running', claimed_at=? WHERE id=?")
            .run(Date.now(), jobId);
          if (scenario.mode !== 'old') recordReleaseJobProgress(jobId, 'coordinator', []);
        }
        t.mock.timers.tick(30_000);
        if (scenario.mode === 'progress') recordReleaseJobProgress(jobId, 'coordinator', []);
        if (scenario.success && Date.now() - start === scenario.end)
          completeAgentJob(jobId, 'coordinator', {
            success: true,
            result: { phase: 'verified', verified: true },
          });
      },
    });
    const result = transport('coordinator', application, payload('verify'));
    if (scenario.success) assert.equal((await result).verified, true);
    else
      await assert.rejects(result, (error: any) => {
        assert.equal(error.message, timeoutMessage);
        assert.equal(error.requiresRecovery, scenario.mode !== 'unclaimed');
        return true;
      });
    assert.equal(Date.now() - start, scenario.end);
    assert.equal(
      getAgentJob(jobId)!.status,
      scenario.success ? 'complete' : scenario.mode === 'unclaimed' ? 'failed' : 'running',
    );
    // Isolate later claim tests from these intentionally stranded durable jobs.
    getSqlite()!.prepare('DELETE FROM agent_jobs WHERE id=?').run(jobId);
  });
}

test('release progress is durable, scoped to a claimed job, and never requeues a slow release', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const job = enqueueAgentJob({
    nodeId: 'coordinator',
    deploymentName: 'progress-test',
    type: 'project-release',
    payload: {},
  });
  assert.throws(() => recordReleaseJobProgress(job.id, 'coordinator', []), /claimed/);
  // Earlier failed fixture jobs are terminal; this is the only queued job.
  assert.equal(claimAgentJob('coordinator')!.id, job.id);
  assert.throws(() => recordReleaseJobProgress(job.id, 'other', []), /claimed/);
  assert.throws(
    () => recordReleaseJobProgress(job.id, 'coordinator', [{ name: 'invented' }]),
    /Invalid/,
  );
  const parts = [{ name: 'copy data', startedAt: new Date().toISOString() }];
  recordReleaseJobProgress(job.id, 'coordinator', parts);
  assert.deepEqual(JSON.parse(getAgentJob(job.id)!.progress!), { receivedAt: Date.now(), parts });
  t.mock.timers.tick(21 * minute);
  recordReleaseJobProgress(job.id, 'coordinator', parts);
  assert.equal(claimAgentJob('coordinator'), null);
  assert.equal(getAgentJob(job.id)!.status, 'running');
  // A worker restart can still reclaim an abandoned job once its extended lease expires.
  t.mock.timers.tick(21 * minute);
  assert.equal(claimAgentJob('coordinator')!.id, job.id);
  completeAgentJob(job.id, 'coordinator', { success: true });
  assert.throws(() => recordReleaseJobProgress(job.id, 'coordinator', []), /claimed/);
});

for (const [name, phase, failures, message, attempts] of [
  [
    'recovers a transient control reset',
    'watch',
    1,
    '502: control plane closed the connection before responding',
    2,
  ],
  [
    'fails a persistent control reset',
    'watch',
    4,
    '502: control plane closed the connection before responding',
    3,
  ],
  ['fails an application health error', 'watch', 1, 'service stopped during Watch', 1],
  [
    'keeps activation single-shot',
    'activate',
    1,
    '502: control plane closed the connection before responding',
    1,
  ],
] as const) {
  test(name, async () => {
    let seen = 0;
    const transport = createReleaseNodeTransport({
      now: Date.now,
      sleep: async (ms) => {
        if (ms !== 250) return;
        const job = claimAgentJob('coordinator');
        assert.ok(job);
        completeAgentJob(
          job.id,
          'coordinator',
          ++seen <= failures
            ? { success: false, error: message }
            : { success: true, result: { phase: 'activated', verified: true } },
        );
      },
    });
    const job = transport('coordinator', 'watch-test', { ...payload(phase), releaseId: name });
    if (attempts > failures) assert.equal((await job).verified, true);
    else await assert.rejects(job, (e) => e instanceof Error && e.message === message);
    assert.equal(seen, attempts);
  });
}
