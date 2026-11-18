import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deployFailure, jobStep, toolName, toolStep } from './work-steps.ts';
import { mapConversationEvent } from './conversation-events.ts';

const at = '2026-11-16T18:20:39Z';
const row = (type: string, payload: object, extra: object = {}) => ({
  type,
  payload,
  cursor: 1,
  runId: 'run',
  taskId: 'task',
  createdAt: at,
  ...extra,
});
const deploy = {
  id: 'toolu_1',
  type: 'tool_call',
  name: 'mcp__deploy__deploy_application',
  arguments: { operationId: 'deploy-drop-1', checkpointId: 'c', name: 'drop' },
};
const output = (value: object) => [{ type: 'text', text: JSON.stringify(value) }];

test('tool names lose their server prefix, and plumbing has no step', () => {
  assert.equal(toolName('mcp__deploy__deploy_application'), 'deploy_application');
  assert.equal(toolName('mcp__claude-in-chrome__navigate'), 'navigate');
  assert.equal(toolName('Bash'), 'Bash');
  for (const name of ['ToolSearch', 'mcp__deploy__deploy_get_job', 'mcp__deploy__deploy_run_job'])
    assert.equal(toolStep({ name }, true), undefined, name);
});

test('a deploy reads Deploying, then Live at its address or Failed with the reason', () => {
  assert.deepEqual(toolStep(deploy, false), {
    icon: 'pulse',
    glyph: 'deploy',
    text: 'Deploying drop',
    live: true,
  });
  const live = toolStep(
    {
      ...deploy,
      output: output({ status: 'running', url: 'https://drop.local', deploymentId: '1357' }),
    },
    true,
  );
  assert.equal(live?.text, 'Deployed drop');
  assert.equal(live?.outcome, 'Live at drop.local');
  assert.equal(live?.outcomeHref, 'https://drop.local');
  assert.deepEqual(live?.links, [{ label: 'View logs', href: '/dashboard/drop/build' }]);
  assert.equal(live?.tone, undefined);
  const timed = toolStep(
    {
      ...deploy,
      startedAt: '2026-11-16T16:20:00Z',
      output: output({ status: 'running', url: 'https://drop.local' }),
    },
    true,
    '2026-11-16T16:20:41Z',
  );
  assert.equal(timed?.seconds, 41);

  // The failure from the trial: the app's own name comes from its address when not given.
  const failed = toolStep(
    {
      name: 'mcp__deploy__deploy_application',
      arguments: {},
      output: output({
        status: 'failed',
        url: 'https://drop.local',
        deploymentId: '1352',
        logTail:
          'Deployment stopped. Check configuration and build logs before retrying.\n[2026-11-16T16:20:39.476Z] Source artifact accepted by the coordinator\n[2026-11-16T16:20:42.108Z] Deployment failed: Component "web" instance "verify-3bc1/web/1" failed its health gate\n',
      }),
    },
    true,
  );
  assert.equal(failed?.text, 'Deployed drop');
  assert.equal(failed?.outcome, 'Failed: health check');
  assert.equal(failed?.tone, 'fail');
  assert.match(failed?.reason || '', /failed its health gate/);
  // The reason is shown once, and lines every deploy log has are no tail at all.
  assert.equal(failed?.tail, undefined);
  const withOutput = toolStep(
    {
      ...deploy,
      output: output({
        status: 'failed',
        url: 'https://tally.local',
        logTail:
          '[t] Source artifact accepted by the coordinator\n[t] Triggered by gabrielcsapo via task Ship it\n[t] web  Error: EACCES: permission denied, open \'/app/server.mjs\'\n[t] Deployment failed: Component "web" failed its health gate',
      }),
    },
    true,
  );
  assert.deepEqual(withOutput?.tail, [
    "web  Error: EACCES: permission denied, open '/app/server.mjs'",
  ]);
  const unchanged = toolStep(
    {
      ...deploy,
      output: output({ status: 'running', url: 'https://drop.local', unchanged: true }),
    },
    true,
  );
  assert.equal(unchanged?.outcome, 'Already live at drop.local');
});

test('a deploy the tool stopped waiting for is not called a failure', () => {
  const step = toolStep(
    {
      ...deploy,
      isError: true,
      output:
        'Timed out waiting for build/start after 10 minutes; the deployment may still finish. Inspect View logs before retrying.',
    },
    true,
  );
  assert.equal(step?.outcome, 'Still deploying after 10 minutes');
  assert.equal(step?.tone, 'warn');
  assert.equal(
    deployFailure('Ready instance "x" has no published port for y').outcome,
    'Failed: no published port',
  );
});

test('everyday tools read as what they did', () => {
  assert.equal(
    toolStep(
      { name: 'Bash', arguments: { command: 'ls -la', description: 'List workspace' } },
      true,
    )?.text,
    'List workspace',
  );
  assert.equal(
    toolStep({ name: 'Read', arguments: { file_path: '/w/server.js' } }, true)?.text,
    'Read server.js',
  );
  assert.equal(
    toolStep({ name: 'Edit', arguments: { file_path: '/w/public/index.html' } }, true)?.text,
    'Edited index.html',
  );
  const failed = toolStep({ name: 'Bash', arguments: { command: 'false' }, isError: true }, true);
  assert.equal(failed?.outcome, 'Failed');
  assert.equal(failed?.tone, 'fail');
  assert.equal(
    toolStep(
      {
        name: 'mcp__deploy__deploy_commit',
        output: output({ commit: 'a6601d82afc75bf0', branch: 'main', files: 8 }),
      },
      true,
    )?.text,
    'Committed a6601d82 to main',
  );
});

test('a job step names its job and computer, and says how it went', () => {
  const job = {
    id: 'j',
    name: 'Run Drop test suite on Linux',
    command: 'node --test test/',
    createdAt: '2026-11-16T16:20:00Z',
    updatedAt: '2026-11-16T16:20:12Z',
  };
  const done = jobStep(
    job,
    'job.succeeded',
    { jobId: 'j', exitCode: 0 },
    { computer: 'SER', taskId: 't' },
  );
  assert.equal(done.text, 'Run Drop test suite on Linux');
  assert.equal(done.outcome, 'Passed on SER');
  assert.equal(done.seconds, 12);
  assert.deepEqual(done.links, [{ label: 'Output', href: '/dashboard/tasks/t/checks' }]);
  const failed = jobStep(job, 'job.failed', { jobId: 'j', exitCode: 1 }, { computer: 'SER' });
  assert.equal(failed.outcome, 'Failed on SER (exit 1)');
  assert.equal(failed.tone, 'fail');
  assert.equal(jobStep(job, 'job.running', {}).live, true);
});

test('a result keeps its call name, and an ended run stops its spinner', () => {
  const context = { calls: new Map() };
  const started = mapConversationEvent(
    row('item.started', { item: deploy }),
    { status: 'running' },
    context,
  );
  assert.equal(started?.kind === 'worklog' && started.summary, 'Deploying drop');
  assert.equal(started?.kind === 'worklog' && started.live, true);
  // Results written before tools carried their names still read as the call.
  const completed = mapConversationEvent(
    row('item.completed', {
      item: {
        id: 'toolu_1',
        type: 'tool_result',
        output: output({ status: 'running', url: 'https://drop.local' }),
      },
    }),
    { status: 'running' },
    context,
  );
  assert.equal(completed?.id, started?.id);
  assert.equal(completed?.kind === 'worklog' && completed.steps[0].outcome, 'Live at drop.local');

  const interrupted = mapConversationEvent(
    row('item.started', { item: { ...deploy, id: 'toolu_2' } }),
    { status: 'interrupted', error: 'The computer restarted during this run' },
    { calls: new Map() },
  );
  assert.equal(interrupted?.kind === 'worklog' && interrupted.live, false);
  assert.equal(interrupted?.kind === 'worklog' && interrupted.steps[0].outcome, 'Interrupted');
  assert.equal(interrupted?.kind === 'worklog' && interrupted.steps[0].tone, 'warn');

  assert.equal(
    mapConversationEvent(
      row('item.started', { item: { id: 't', type: 'tool_call', name: 'ToolSearch' } }),
    ),
    undefined,
  );
});

test('a job event after the first names its job from the record', () => {
  const job = { id: 'j', name: 'Run tests', workerId: 'w', taskId: 't' };
  const event = mapConversationEvent(
    row('job.succeeded', { jobId: 'j', workerId: 'w', exitCode: 0 }),
    undefined,
    {
      job: () => job,
      computer: () => 'SER',
    },
  );
  assert.equal(event?.kind === 'worklog' && event.summary, 'Run tests');
  assert.equal(event?.kind === 'worklog' && event.steps[0].outcome, 'Passed on SER');
});

test('the stored deploy summary message is not repeated as a reply', () => {
  assert.equal(
    mapConversationEvent(
      row('message', {
        id: 'deployment:abc',
        role: 'assistant',
        content: '> **drop** · failed\n>\n> [https://drop.local](https://drop.local)',
      }),
    ),
    undefined,
  );
});

test("a pipeline's job ticks are no conversation's", () => {
  const ticks = mapConversationEvent(
    { ...row('job.progress', { jobId: 'lint' }), taskId: null, runId: null },
    undefined,
    { job: () => ({ id: 'lint', name: 'lint' }) },
  );
  assert.equal(ticks, undefined);
  const taskJob = mapConversationEvent(row('job.progress', { jobId: 'tests' }), undefined, {
    job: () => ({ id: 'tests', name: 'Run tests', taskId: 'task' }),
  });
  assert.equal(taskJob?.kind, 'worklog');
});
