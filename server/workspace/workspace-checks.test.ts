import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DEPLOY_DATA_DIR = mkdtempSync(join(tmpdir(), 'workspace-checks-'));
const { workspaceChecks, publishedTaskChecks, workspaceChecksLimit, pullTaskChecks } =
  await import('./workspace-checks.ts');
const { editWatermark } = await import('./activity.ts');
const { event, save, db } = await import('./store.ts');
const { publishDescription } = await import('./task-presentation.ts');
const { verificationCommand, scrubCheckText } = await import('./workspace-verification.ts');
after(() => {
  db.close();
  rmSync(process.env.DEPLOY_DATA_DIR!, { recursive: true, force: true });
});
const runs = [{ id: 'run', workerId: 'mac' }];
const workers = [{ id: 'mac', name: 'MacBook Pro' }];
const command = (
  id: string,
  cursor: number,
  cmd = 'pnpm test',
  exit = 0,
  type = 'item.completed',
) => ({
  cursor,
  runId: 'run',
  type,
  createdAt: new Date(1_000 * cursor).toISOString(),
  payload: { item: { id, type: 'command_execution', command: cmd, exit_code: exit } },
});
/** A Claude agent's Bash call: a tool call that carries the command, then a tool result that
 * carries the output and an error flag, with no exit code anywhere. */
const bash = (id: string, cursor: number, cmd: string) => ({
  cursor,
  runId: 'run',
  type: 'item.started',
  createdAt: new Date(1_000 * cursor).toISOString(),
  payload: { item: { id, type: 'tool_call', name: 'Bash', arguments: { command: cmd } } },
});
const bashResult = (id: string, cursor: number, output: string, isError = false) => ({
  cursor,
  runId: 'run',
  type: 'item.completed',
  createdAt: new Date(1_000 * cursor).toISOString(),
  payload: { item: { id, type: 'tool_result', output: [{ type: 'text', text: output }], isError } },
});
/** A Mac keeps its tasks under a root with a space in it, which is how a worker path survived
 * scrubbing and reached a check label on pull request #13. */
const workspacePath =
  '/Users/gabrielcsapo/Library/Application Support/deploy.local/worker/tasks/807f8ec3';
const taskContext = { id: '807f8ec3', workspacePath };
/** The command form and tail from task 807f8ec3 (pull request #13), which ran 209 tests. */
const webTests = `cd "${workspacePath}" && node --import tsx --test app/routes/dashboard/*.test.ts 2>&1 | tail -60`;
const webTestsPassed = 'ℹ tests 209\nℹ pass 209\nℹ fail 0\nℹ duration_ms 1835.2';
const edit = (cursor: number) => ({
  cursor,
  runId: 'run',
  type: 'item.completed',
  createdAt: new Date(1_000 * cursor).toISOString(),
  payload: { item: { id: `edit-${cursor}`, type: 'file_change' } },
});

test('recognizes verification executables and rejects reads, writes, quoted mentions and mixed commands', () => {
  for (const cmd of [
    'pnpm typecheck',
    'pnpm run test:web',
    'node --import tsx --test app/*.test.ts',
    'npx oxfmt --check a.ts',
    'cd native && swift test',
    'xcodebuild -scheme App test',
    'cargo test',
    'go vet ./...',
    'pytest',
    'env CI=1 pnpm test',
  ])
    assert.equal(verificationCommand(cmd), true, cmd);
  for (const cmd of [
    'ls',
    'cat test.ts',
    'git status',
    'echo "pnpm test"',
    'npx oxfmt a.ts',
    'pnpm lint --fix',
    'pnpm test && touch source.ts',
    'pnpm test; rm a',
    'pnpm test > source.ts',
    'pnpm test || true',
    'sh -c "pnpm test"',
  ])
    assert.equal(verificationCommand(cmd), false, cmd);
});

test('completed workspace checks after the last edit pass; failures and older runs stay truthful', () => {
  const events = [
    edit(1),
    command('test', 2, 'pnpm test', 0, 'item.started'),
    command('test', 4),
    command('typecheck', 5, 'pnpm typecheck', 1),
  ];
  const checks = workspaceChecks(events, runs, workers);
  assert.equal(checks.length, 2);
  assert.equal(checks[0].status, 'succeeded');
  assert.equal(checks[0].exitCode, 0);
  assert.equal(checks[0].durationMs, 2000);
  assert.equal(checks[0].watermark, editWatermark(events));
  assert.equal(checks[0].sourceLabel, 'Ran in the task workspace on MacBook Pro');
  assert.equal(checks[1].status, 'failed');
  const body = publishDescription({}, [], checks, [], '', { watermark: editWatermark(events) });
  assert.match(body, /pnpm test: Passed.*Ran in the task workspace on MacBook Pro/);
  assert.match(body, /pnpm typecheck: Failed/);
  assert.doesNotMatch(body, /Earlier runs/);
  const later = publishDescription({}, [], checks, [], '', {
    watermark: editWatermark([...events, edit(6)]),
  });
  assert.match(later, /No checks ran on this version/);
  assert.match(later, /Earlier runs \(2\)/);
  assert.notEqual(
    editWatermark([...events, command('write', 6, 'python3 change.py')]),
    checks[0].watermark,
  );
});

test('edits during a check, interrupted commands and non-verification commands cannot pass', () => {
  const events = [
    command('one', 1, 'pnpm test', 0, 'item.started'),
    edit(2),
    command('one', 3),
    command('read', 4, 'ls'),
    command('unfinished', 5, 'pnpm typecheck', 0, 'item.started'),
  ];
  const checks = workspaceChecks(events, runs, workers);
  assert.equal(checks.length, 1);
  assert.notEqual(checks[0].watermark, editWatermark(events));
  assert.equal(
    workspaceChecks(
      [
        {
          ...command('missing', 1),
          payload: { item: { id: 'missing', type: 'command_execution', command: 'pnpm test' } },
        },
      ],
      runs,
      workers,
    ).length,
    0,
  );
});

test('command text is scrubbed before truncation and repeated commands are bounded', () => {
  const raw = `TOKEN="private value" pnpm test --password 'hidden words' --api-key=hidden-key --token shortsecret https://user:pass@host/?token=secret Bearer abc123 ghp_abcdefghijklmnopqrstuvwxyz`;
  const clean = scrubCheckText(raw);
  for (const secret of [
    'private value',
    'hidden words',
    'hidden-key',
    'shortsecret',
    'user:pass',
    'token=secret',
    'abc123',
    'ghp_abcdefghijklmnopqrstuvwxyz',
  ])
    assert.ok(!clean.includes(secret), secret);
  const repeated = workspaceChecks(
    [command('a', 1), command('b', 2, 'pnpm test', 1)],
    runs,
    workers,
  );
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].status, 'failed');
  assert.equal(repeated[0].attempts, 2);
  const many = Array.from({ length: 100 }, (_, i) =>
    command(`${i}`, i + 1, `pnpm test --case ${i}`),
  );
  assert.equal(workspaceChecks(many, runs, workers).length, workspaceChecksLimit);
});

test('ordinary flag values survive scrubbing while real credentials never do', () => {
  // What a check checked is the point of its label, so an ordinary `--flag=value` is kept.
  for (const kept of [
    'node --test --test-name-pattern="never claims" app/a.test.mjs',
    'node --test --test-name-pattern=monkey app/a.test.mjs',
    'pnpm test --reporter=dot --grep "deploys the app"',
    // A name that merely contains a secret word is not one: only whole words are credentials.
    'git log --author=Gabriel --keyword=monkey',
    'xcodebuild -scheme App -destination "platform=iOS Simulator,name=iPhone 17" test',
  ])
    assert.equal(scrubCheckText(kept), kept);
  for (const [raw, secret] of [
    ['FOO_TOKEN=abc123xyz pnpm test', 'abc123xyz'],
    ['env DEPLOY_PASSWORD=hunter2 pnpm test', 'hunter2'],
    ['pnpm test --password hunter2', 'hunter2'],
    ['pnpm test --api-key=hunter2', 'hunter2'],
    ['curl --fail https://user:hunter2@app.local/health', 'hunter2'],
    ['curl -H "Authorization: Bearer hunter2" https://app.local', 'hunter2'],
    ['curl "https://app.local/?access_token=hunter2"', 'hunter2'],
    ['gh auth login --with-token ghp_abcdefghijklmnopqrstuvwxyz0', 'ghp_abcdefghij'],
  ] as const) {
    const clean = scrubCheckText(raw);
    assert.ok(!clean.includes(secret), raw);
    assert.match(clean, /\[redacted\]/, raw);
  }
});

test('publication freezes only completed runs before the checkpoint and preserves old provenance', () => {
  const task = { id: 'task', workerId: 'mac' };
  save('run', 'owner', { ...runs[0], taskId: task.id });
  save('worker', 'owner', workers[0]);
  for (const item of [edit(1), command('pass', 2), command('fail', 3, 'pnpm lint', 1)])
    event('owner', task.id, 'run', item.type, item.payload);
  const checkpoint = {
    createdAt: new Date(Date.now() + 1000).toISOString(),
    snapshot: { digest: 'snapshot' },
  };
  const frozen = publishedTaskChecks('owner', task, checkpoint, 'head');
  assert.deepEqual(
    frozen.map((row) => row.commit),
    ['head', 'head'],
  );
  event('owner', task.id, 'run', 'item.completed', edit(4).payload);
  const later = publishedTaskChecks(
    'owner',
    { ...task, publishedCheckRuns: frozen },
    checkpoint,
    'next',
  );
  assert.deepEqual(
    later.map((row) => row.commit),
    ['head', 'head'],
  );
  assert.deepEqual(
    frozen.map((row) => row.status),
    ['succeeded', 'failed'],
  );
});

test('old publication checkpoints backfill checks and follow-up branches stay separate', () => {
  const task = {
    id: 'backfill',
    projectId: 'project',
    workerId: 'mac',
    publishedCommit: 'old-head',
    publishedCheckpointId: 'old-capture',
  };
  save('run', 'backfill-owner', { id: 'run', taskId: task.id, workerId: 'mac' });
  save('worker', 'backfill-owner', workers[0]);
  event('backfill-owner', task.id, 'run', 'item.completed', command('check', 1).payload);
  save('checkpoint', 'backfill-owner', {
    id: 'old-capture',
    taskId: task.id,
    createdAt: new Date(Date.now() + 1000).toISOString(),
    snapshot: { digest: 'old-digest' },
  });
  save('task', 'backfill-owner', task);
  const pull = { projectId: 'project', taskIds: [task.id], sourceBranch: 'task/backfill' };
  const backfilled = pullTaskChecks('backfill-owner', pull);
  assert.equal(backfilled.length, 1);
  assert.equal(backfilled[0].commit, 'old-head');
  save('task', 'backfill-owner', {
    ...task,
    publishedCheckRuns: [
      ...backfilled,
      { id: 'follow-up', sourceBranch: 'task/backfill-2', commit: 'next-head', status: 'failed' },
    ],
  });
  assert.deepEqual(pullTaskChecks('backfill-owner', pull), backfilled);
  assert.equal(
    pullTaskChecks('backfill-owner', { ...pull, sourceBranch: 'task/backfill-2' })[0].id,
    'follow-up',
  );
});

test('overlapping repeats collapse by completion order and credential flags and headers are scrubbed', () => {
  const events = [
    command('a', 1, 'pnpm test', 0, 'item.started'),
    command('b', 2, 'pnpm test', 0, 'item.started'),
    command('b', 3, 'pnpm test', 1),
    command('a', 4),
  ];
  assert.equal(workspaceChecks(events, runs, workers)[0].exitCode, 0);
  assert.equal(verificationCommand('pnpm test & touch source.ts'), false);
  assert.equal(verificationCommand('pnpm lint --fix=true'), false);
  const clean = scrubCheckText(
    `pnpm test --config '{"token":"private-token"}' --header 'X-Api-Key: private-key' --header 'Authorization: Basic private-basic'`,
  );
  for (const secret of ['private-token', 'private-key', 'private-basic'])
    assert.ok(!clean.includes(secret));
});

test('tool lifecycle completion advances the edit watermark even when the result omits the command', () => {
  const events = [
    {
      ...command('writer', 1),
      type: 'item.started',
      payload: {
        item: {
          id: 'writer',
          type: 'tool_call',
          name: 'Bash',
          arguments: { command: 'python3 change.py' },
        },
      },
    },
    command('check', 2, 'pnpm test', 0, 'item.started'),
    command('check', 3),
    {
      ...command('writer', 4),
      payload: { item: { id: 'writer', type: 'tool_result', output: 'done' } },
    },
  ];
  assert.equal(editWatermark(events), '4');
  assert.notEqual(workspaceChecks(events, runs, workers)[0].watermark, editWatermark(events));
});

test('recorded jobs run after capture still count when their checkpoint digest matches', () => {
  const task = { id: 'job-task' };
  save('job', 'jobs-owner', {
    id: 'job',
    taskId: task.id,
    checkpointId: 'capture',
    digest: 'exact',
    status: 'succeeded',
    command: 'swift test',
    createdAt: '2026-10-26T12:10:00Z',
  });
  const checks = publishedTaskChecks(
    'jobs-owner',
    task,
    { createdAt: '2026-10-26T12:00:00Z', snapshot: { digest: 'exact' } },
    'head',
  );
  assert.equal(checks[0].commit, 'head');
  assert.equal(checks[0].source, 'job');
});

test('a piped test run an agent ran itself counts as a check on the current version', () => {
  const events = [edit(1), bash('tests', 2, webTests), bashResult('tests', 4, webTestsPassed)];
  const checks = workspaceChecks(events, runs, workers, taskContext);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, 'succeeded');
  assert.equal(checks[0].piped, true);
  // `tail` owns the exit code, so there is none to record; the summary decided the result.
  assert.equal(checks[0].exitCode, null);
  assert.match(checks[0].evidence, /ℹ fail 0/);
  assert.equal(checks[0].durationMs, 2000);
  // Verification is not an edit, so the run still speaks for the version it ran on.
  assert.equal(checks[0].watermark, editWatermark(events));
  // The headline is the check, not the shell it ran in; the command follows underneath, whole.
  assert.equal(checks[0].label, 'node --test app/routes/dashboard/*.test.ts');
  assert.equal(
    checks[0].command,
    'cd . && node --import tsx --test app/routes/dashboard/*.test.ts 2>&1 | tail -60',
  );
  const body = publishDescription(taskContext, [], checks, [], '', {
    watermark: editWatermark(events),
  });
  assert.match(body, /- node --test app\/routes\/dashboard\/\*\.test\.ts: Passed/);
  assert.match(body, /Passed \(output: ℹ fail 0\)/);
  assert.match(body, /\n {2}- Command: `cd \. && node --import tsx --test .*tail -60`/);
  for (const fragment of ['/Users', 'Application Support', 'worker/tasks', '807f8ec3'])
    assert.ok(!body.includes(fragment), fragment);
  assert.doesNotMatch(body, /No checks ran on this version/);
});

test('a piped run whose output does not say is recorded as unknown, never as a pass', () => {
  const events = [
    bash('tests', 1, webTests),
    bashResult('tests', 2, 'Running the dashboard suite…'),
    bash('types', 3, 'pnpm typecheck 2>&1 | tail -20'),
    bashResult('types', 4, 'server/workspace/activity.ts(21,7): error TS2345: Not assignable.'),
  ];
  const checks = workspaceChecks(events, runs, workers, taskContext);
  assert.deepEqual(
    checks.map((check) => check.status),
    ['unknown', 'failed'],
  );
  assert.equal(checks[0].evidence, '');
  const body = publishDescription(taskContext, [], checks, [], '', {
    watermark: editWatermark(events),
  });
  assert.match(
    body,
    /- node --test app\/routes\/dashboard\/\*\.test\.ts: Result unknown \(output piped\)/,
  );
  assert.match(body, /- pnpm typecheck: Failed \(output: .*error TS2345/);
  assert.match(body, /- Command: `pnpm typecheck 2>&1 \| tail -20`/);
  assert.doesNotMatch(body, /Passed/);
});

test('output read for a result is scrubbed, and a failing summary outranks a passing one', () => {
  const noisy = `TOKEN="private value" pnpm test\nℹ fail 0\nserver/a.ts(2,1): error TS2554: TOKEN="private value" is not callable.`;
  const checks = workspaceChecks(
    [bash('tests', 1, webTests), bashResult('tests', 2, noisy)],
    runs,
    workers,
  );
  assert.equal(checks[0].status, 'failed');
  assert.ok(!checks[0].evidence.includes('private value'), checks[0].evidence);
  assert.match(checks[0].evidence, /TOKEN=\[redacted\]/);
});

test('a published task that only piped its tests shows the run on its commit', () => {
  const task = {
    id: '807f8ec3',
    projectId: 'project',
    workerId: 'mac',
    publishedCommit: 'piped-head',
    publishedCheckpointId: 'piped-capture',
  };
  save('run', 'piped-owner', { id: 'run', taskId: task.id, workerId: 'mac' });
  save('worker', 'piped-owner', workers[0]);
  for (const item of [bash('tests', 1, webTests), bashResult('tests', 2, webTestsPassed)])
    event('piped-owner', task.id, 'run', item.type, item.payload);
  save('checkpoint', 'piped-owner', {
    id: 'piped-capture',
    taskId: task.id,
    createdAt: new Date(Date.now() + 1000).toISOString(),
    snapshot: { digest: 'piped-digest' },
  });
  save('task', 'piped-owner', task);
  const runsOnPull = pullTaskChecks('piped-owner', {
    projectId: 'project',
    taskIds: [task.id],
    sourceBranch: 'task/807f8ec3',
  });
  assert.equal(runsOnPull.length, 1);
  assert.equal(runsOnPull[0].commit, 'piped-head');
  assert.equal(runsOnPull[0].status, 'succeeded');
  assert.equal(runsOnPull[0].piped, true);
  assert.match(runsOnPull[0].evidence, /ℹ fail 0/);
  assert.match(runsOnPull[0].sourceLabel, /Ran in the task workspace on MacBook Pro/);
  // The task id places its own workspace even when the record kept no path for it.
  assert.equal(runsOnPull[0].label, 'node --test app/routes/dashboard/*.test.ts');
  assert.ok(!runsOnPull[0].command.includes('Application Support'), runsOnPull[0].command);
});
