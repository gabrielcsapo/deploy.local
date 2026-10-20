import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DEPLOY_DATA_DIR = mkdtempSync(join(tmpdir(), 'deploy-turn-test-'));
const { get, list, save } = await import('./store.ts');
const { createProject, createTask } = await import('./test-repository.ts');
const { startRun, git, turnDiff } = await import('./service.ts');
const { captureTurnCheckpoint, diffTurnCheckpoints } = await import('./turn-checkpoint.ts');
const { queueMessage, cancelQueuedMessage, queuedMessage, releaseQueuedMessage } =
  await import('./queued-message.ts');
const { workerCommand } = await import('./protocol.ts');

const end = (owner: string, runId: string, status: string, patch: Record<string, any> = {}) =>
  save('run', owner, { ...get('run', owner, runId), status, ...patch });

test('turn checkpoints leave the index alone and skip credential files', () => {
  const p = createProject('turns', { name: 'Checkpoints' }),
    t = createTask('turns', { projectId: p.id, title: 'Capture' });
  writeFileSync(join(t.workspacePath, 'staged.txt'), 'staged\n');
  git(t.workspacePath, ['add', 'staged.txt']);
  const index = git(t.workspacePath, ['diff', '--cached', '--name-only']);
  const head = git(t.workspacePath, ['rev-parse', 'HEAD']);
  const before = captureTurnCheckpoint(t.workspacePath);
  writeFileSync(join(t.workspacePath, 'notes.md'), 'one\n');
  writeFileSync(join(t.workspacePath, '.env'), 'SECRET=1\n');
  const after = captureTurnCheckpoint(t.workspacePath);
  assert.equal(git(t.workspacePath, ['diff', '--cached', '--name-only']), index);
  assert.equal(git(t.workspacePath, ['rev-parse', 'HEAD']), head);
  const turn = diffTurnCheckpoints(t.workspacePath, before, after);
  assert.deepEqual(turn.files, [{ status: 'A', path: 'notes.md' }]);
  assert.match(turn.patch, /\+one\n$/);
  assert.equal(turn.patch.includes('SECRET'), false);
  assert.equal(
    diffTurnCheckpoints(t.workspacePath, after, after).status,
    'This turn made no file changes.',
  );
});

test('this turn diffs the latest turn checkpoints and falls back honestly', () => {
  const p = createProject('turns', { name: 'Turns' }),
    t = createTask('turns', { projectId: p.id, title: 'Iterate' });
  assert.equal(turnDiff('turns', t.id).scope, 'all');
  assert.match(turnDiff('turns', t.id).note, /No turns yet/);
  const first = startRun('turns', t.id, { revision: 0, content: 'first' });
  writeFileSync(join(t.workspacePath, 'first.txt'), 'first\n');
  end('turns', first.id, 'succeeded', { checkpoint: captureTurnCheckpoint(t.workspacePath) });
  // Runs recorded before checkpoints existed have no start tree; the first turn shows everything.
  assert.match(turnDiff('turns', t.id).note, /first turn/);
  const second = startRun('turns', t.id, {
    revision: get('task', 'turns', t.id).revision,
    content: 'second',
  });
  writeFileSync(join(t.workspacePath, 'second.txt'), 'second\n');
  // While a local turn runs, its changes so far are compared with the previous turn's end.
  const live = turnDiff('turns', t.id);
  assert.equal(live.scope, 'turn');
  assert.deepEqual(
    live.files.map((f: any) => f.path),
    ['second.txt'],
  );
  end('turns', second.id, 'succeeded', { checkpoint: captureTurnCheckpoint(t.workspacePath) });
  writeFileSync(join(t.workspacePath, 'after.txt'), 'outside the turn\n');
  const finished = turnDiff('turns', t.id);
  assert.equal(finished.runId, second.id);
  assert.deepEqual(
    finished.files.map((f: any) => f.path),
    ['second.txt'],
  );
  const third = startRun('turns', t.id, {
    revision: get('task', 'turns', t.id).revision,
    content: 'third',
  });
  end('turns', third.id, 'succeeded', { startCheckpoint: 'f'.repeat(40), checkpoint: null });
  assert.match(turnDiff('turns', t.id).note, /no longer available/);
});

test('remote turns use the diff the task computer uploaded', () => {
  workerCommand('turns', '/workers/register', {
    workerId: 'turn-remote',
    name: 'Remote',
    codex: true,
  });
  const p = createProject('turns', { name: 'Remote turns' }),
    t = createTask('turns', { projectId: p.id, title: 'Remote', workerId: 'turn-remote' });
  const run = startRun('turns', t.id, { revision: 0, content: 'remote' });
  const assigned = workerCommand('turns', '/workers/turn-remote/poll', {});
  assert.match(turnDiff('turns', t.id).note, /first turn/);
  workerCommand('turns', '/workers/turn-remote/complete', {
    runId: run.id,
    generation: assigned.run.generation,
    status: 'succeeded',
    diff: { patch: 'all changes', files: [], checks: [] },
    startCheckpoint: 'a'.repeat(40),
    checkpoint: 'b'.repeat(40),
    turnDiff: {
      baseRevision: 'a'.repeat(40),
      headRevision: 'b'.repeat(40),
      patch: 'turn patch',
      files: [{ status: 'M', path: 'app.js' }],
      truncated: false,
    },
  });
  const turn = turnDiff('turns', t.id);
  assert.equal(turn.scope, 'turn');
  assert.equal(turn.patch, 'turn patch');
  assert.deepEqual(turn.files, [{ status: 'M', path: 'app.js' }]);
  assert.equal(get('run', 'turns', run.id).checkpoint, 'b'.repeat(40));
});

test('a queued follow-up sends after a successful turn and is held after a failure', () => {
  const p = createProject('queue', { name: 'Queue' }),
    t = createTask('queue', { projectId: p.id, title: 'Queue' });
  // No active turn: queueing sends immediately instead of waiting forever.
  const direct = queueMessage('queue', t.id, { content: 'start now' });
  assert.equal(direct.sent, true);
  const queued = queueMessage('queue', t.id, { content: 'next please', adapter: 'codex' });
  assert.equal(queued.sent, false);
  assert.equal(queuedMessage('queue', t.id).status, 'queued');
  assert.throws(() => queueMessage('queue', t.id, { content: 'another' }), /already queued/);
  end('queue', direct.run!.id, 'succeeded');
  const sent = releaseQueuedMessage('queue', t.id, 'succeeded');
  assert.ok(sent);
  assert.equal(queuedMessage('queue', t.id), null);
  assert.equal(
    list('message', 'queue')
      .filter((m) => m.taskId === t.id)
      .at(-1).content,
    'next please',
  );
  queueMessage('queue', t.id, { content: 'after the stop' });
  end('queue', sent!.id, 'interrupted');
  assert.equal(releaseQueuedMessage('queue', t.id, 'interrupted'), null);
  assert.deepEqual(
    [queuedMessage('queue', t.id).status, queuedMessage('queue', t.id).reason],
    ['held', 'Not sent because the turn was stopped.'],
  );
  // A held message stays until the person sends or dismisses it.
  assert.equal(cancelQueuedMessage('queue', t.id).cancelled, true);
  assert.equal(queuedMessage('queue', t.id), null);
  const again = startRun('queue', t.id, {
    revision: get('task', 'queue', t.id).revision,
    content: 'manual',
  });
  queueMessage('queue', t.id, { content: 'superseded' });
  end('queue', again.id, 'failed');
  releaseQueuedMessage('queue', t.id, 'failed');
  assert.equal(queuedMessage('queue', t.id).reason, 'Not sent because the turn failed.');
  startRun('queue', t.id, { revision: get('task', 'queue', t.id).revision, content: 'resend' });
  assert.equal(queuedMessage('queue', t.id), null);
});
