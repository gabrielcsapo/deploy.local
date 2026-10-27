import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'publish-presentation-'));
process.env.DEPLOY_DATA_DIR = directory;
const {
  taskPullSummary,
  publishDescription,
  stripWorkspaceLinks,
  agentSummary,
  changeSummary,
  patchFiles,
} = await import('./task-presentation.ts');
const { db } = await import('./store.ts');
after(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

test('task summary derives only same-project linked open or merged pulls', () => {
  const task = { id: 'task', projectId: 'project', status: 'review' };
  const pull = { id: 'pull', projectId: 'project', taskIds: ['task'], number: 5, status: 'open' };
  assert.equal(taskPullSummary(task, []).pull, null);
  assert.equal(taskPullSummary(task, [{ ...pull, status: 'closed' }]).pull, null);
  assert.equal(taskPullSummary(task, [{ ...pull, projectId: 'other' }]).pull, null);
  assert.deepEqual(taskPullSummary(task, [{ ...pull, status: 'merged' }, pull]).pull, {
    id: 'pull',
    number: 5,
    status: 'open',
  });
  assert.equal(taskPullSummary(task, [{ ...pull, status: 'merged' }]).pull?.status, 'merged');
  assert.equal(taskPullSummary(task, [pull]).status, 'review');
});

test('description uses latest final Markdown and recorded checks without inventing success', () => {
  const task = { title: 'Editorial title', workspacePath: '/Users/worker/task' };
  const messages = [
    { role: 'user', content: 'Opening prompt for the change' },
    { role: 'assistant', content: 'Old summary' },
    { role: 'assistant', content: '**Done** in [app.ts](/Users/worker/task/src/app.ts:12).' },
    { role: 'assistant', content: 'Still inspecting', isProgress: true },
  ];
  const body = publishDescription(
    task,
    messages,
    [
      { command: 'lint', status: 'succeeded', exitCode: 0 },
      { command: 'test', status: 'failed', exitCode: 1 },
      { command: 'build', status: 'cancelled', exitCode: 0 },
      { command: 'unknown', status: 'unknown' },
      { command: 'legacy', exitCode: 0 },
    ],
    [{ name: 'iOS', status: 'queued' }],
  );
  assert.match(body, /\*\*Done\*\* in src\/app.ts\./);
  assert.doesNotMatch(body, /Old summary|Still inspecting|\/Users\//);
  assert.match(body, /lint: Passed/);
  assert.match(body, /test: Failed/);
  assert.match(body, /build: Not run \(cancelled\)/);
  assert.match(body, /unknown: Not run \(unknown\)/);
  assert.match(body, /legacy: Passed/);
  assert.match(body, /iOS: Not run \(queued\)/);
  // The request the task was given opens the description, not the title it was stored under.
  assert.match(body, /^Request: Opening prompt for the change\n/);
  const empty = publishDescription(task, [], [], []);
  assert.match(empty, /Not run \(no recorded checks or jobs\)/);
  assert.doesNotMatch(empty, /Passed|Failed/);
  assert.match(empty, /^Request: Editorial title\n/);
});

test('repeated runs of one check collapse into its latest result', () => {
  const body = publishDescription(
    { title: 'Fix the tests' },
    [],
    [],
    [
      { name: 'Unit tests', workerId: 'mac', status: 'failed', createdAt: '2026-10-19T10:00:00Z' },
      { name: 'Unit tests', workerId: 'mac', status: 'failed', createdAt: '2026-10-19T10:30:00Z' },
      {
        name: 'Unit tests',
        workerId: 'mac',
        status: 'succeeded',
        createdAt: '2026-10-19T11:00:00Z',
      },
      // The same command elsewhere is a separate check: it verifies another computer.
      {
        command: 'curl  https://app.local /Users/worker/task/out.json',
        workerId: 'linux',
        status: 'succeeded',
        createdAt: '2026-10-19T11:30:00Z',
      },
      {
        command: 'curl https://app.local',
        workerId: 'mac',
        status: 'failed',
        createdAt: '2026-10-19T12:00:00Z',
      },
      {
        command: 'curl https://app.local',
        workerId: 'mac',
        status: 'succeeded',
        createdAt: '2026-10-19T12:30:00Z',
      },
    ],
  );
  assert.equal(
    body.split('## Checks\n')[1],
    [
      '- Unit tests: Passed (2 earlier attempts)',
      // A command keeps its shape but not a worker's directories.
      '- curl https://app.local out.json: Passed',
      '- curl https://app.local: Passed (1 earlier attempt)',
    ].join('\n'),
  );
});

test('checks belong to the version being published, and earlier runs only read as history', () => {
  const task = { title: 'Fix the queue' };
  const job = (name: string, status: string, digest: string, createdAt: string) => ({
    id: name + createdAt,
    name,
    workerId: 'mac',
    checkpointId: 'checkpoint-' + digest,
    digest,
    status,
    createdAt,
  });
  const jobs = [
    // Each attempt was named differently, and all of them ran before the last edit.
    job('Verify final server and web queue flows', 'failed', 'old', '2026-10-19T10:00:00Z'),
    job('Browser-test queued runs', 'failed', 'old', '2026-10-19T10:30:00Z'),
    // The checks that ran against the published checkpoint.
    job('Browser-test queued runs', 'failed', 'head', '2026-10-19T11:00:00Z'),
    job('Browser-test queued runs', 'succeeded', 'head', '2026-10-19T11:30:00Z'),
  ];
  const body = publishDescription(task, [], [], jobs, '', { digest: 'head', watermark: '7' });
  assert.equal(
    body.split('## Checks\n')[1],
    [
      '- Browser-test queued runs: Passed (1 earlier attempt)',
      '',
      '### Earlier runs (2)',
      '- Browser-test queued runs: Failed',
      '- Verify final server and web queue flows: Failed',
    ].join('\n'),
  );
  // Nothing ran against the published checkpoint: say so rather than show a stale result.
  const stale = publishDescription(task, [], [], jobs, '', { digest: null, watermark: '7' });
  assert.equal(
    stale.split('## Checks\n')[1],
    [
      'No checks ran on this version.',
      '',
      '### Earlier runs (4)',
      '- Browser-test queued runs: Passed',
      '- Browser-test queued runs: Failed',
      '- Browser-test queued runs: Failed',
      '- Verify final server and web queue flows: Failed',
    ].join('\n'),
  );
  // A local check names the workspace it read; a later edit moves that watermark on.
  const checks = [
    { id: 'c1', command: 'pnpm test', watermark: '6', status: 'failed', exitCode: 1 },
    { id: 'c2', command: 'pnpm test', watermark: '7', status: 'succeeded', exitCode: 0 },
  ];
  assert.equal(
    publishDescription(task, [], checks, [], '', { digest: null, watermark: '7' }).split(
      '## Checks\n',
    )[1],
    ['- pnpm test: Passed', '', '### Earlier runs (1)', '- pnpm test: Failed'].join('\n'),
  );
  // Records from before checks were placed say nothing about the version they ran on.
  assert.match(
    publishDescription(task, [], [{ id: 'c3', command: 'pnpm test', exitCode: 0 }], [], '', {
      digest: 'head',
      watermark: '7',
    }),
    /No checks ran on this version\.\n\n### Earlier runs \(1\)\n- pnpm test: Passed/,
  );
});

test('chatter is dropped and a chatty final message falls back to the commit it describes', () => {
  assert.equal(agentSummary('No PR was created; nothing was merged.'), '');
  assert.equal(agentSummary('Done.'), '');
  assert.equal(
    agentSummary(
      [
        'Let me run the tests.',
        '',
        'Grouped published checks by name so a retried check reads as one result.',
        'I did not publish or merge anything; the owner publishes it.',
        'Captured a final checkpoint.',
      ].join('\n'),
    ),
    'Grouped published checks by name so a retried check reads as one result.',
  );
  // Narration inside a fenced block is quoted material, not the agent talking.
  assert.match(agentSummary('```\nLet me run the tests\n```\nRenamed the checks column.'), /```/);
  const patch = [
    'diff --git a/server/workspace/publish.ts b/server/workspace/publish.ts',
    '--- a/server/workspace/publish.ts',
    '+++ b/server/workspace/publish.ts',
    '@@ -1 +1,2 @@',
    '-old',
    '+new',
    '+more',
    'diff --git a/server/workspace/checks.ts b/server/workspace/checks.ts',
    '--- a/server/workspace/checks.ts',
    '+++ b/server/workspace/checks.ts',
    '@@ -1 +1 @@',
    '+one',
    'diff --git a/README.md b/README.md',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/README.md',
    '@@ -0,0 +1 @@',
    '+hello',
    '',
  ].join('\n');
  assert.equal(
    changeSummary(patch),
    [
      'Changed 3 files across 2 areas:',
      '- server/workspace: 2 files, +3 −1',
      '- repository root: 1 file, +1 −0',
    ].join('\n'),
  );
  const body = publishDescription(
    { title: 'Make descriptions read well' },
    [{ role: 'assistant', content: 'No PR was created; nothing was merged.' }],
    [],
    [],
    changeSummary(patch),
  );
  assert.match(body, /Changed 3 files across 2 areas:/);
  assert.doesNotMatch(body, /nothing was merged/);
  assert.equal(changeSummary(''), '');
  // Changed lines that look like diff headers are counted inside a hunk, not skipped.
  assert.deepEqual(
    patchFiles(
      [
        'diff --git "a/src/a b.ts" "b/src/a b.ts"',
        '--- "a/src/a b.ts"',
        '+++ "b/src/a b.ts"',
        '@@ -1,2 +1,2 @@',
        '--- removed marker',
        '+++ added marker',
        '',
      ].join('\n'),
    ),
    [{ path: 'src/a b.ts', additions: 1, deletions: 1 }],
  );
});

test('workspace links become plain relative paths and external links survive', () => {
  assert.equal(
    stripWorkspaceLinks(
      '[file](</work/task/a b.ts:2>) [encoded](file:///work/task/a%20b.ts#L4) [other](/private/other/secret.ts:1) [site](https://example.com/doc)',
      '/work/task',
    ),
    'a b.ts a b.ts secret.ts [site](https://example.com/doc)',
  );
});

test('reference links become plain paths, including remote worker workspaces', () => {
  const body = publishDescription(
    { title: 'Task', workspacePath: '/server/task', remoteWorkspacePath: '/mac/task' },
    [
      {
        role: 'assistant',
        content: '[source][code] and [code].\n\n[code]: /mac/task/src/main.ts:5',
      },
    ],
    [],
    [],
  );
  assert.match(body, /src\/main.ts and src\/main.ts\./);
  assert.doesNotMatch(body, /\[code\]|\/mac\/task/);
});
