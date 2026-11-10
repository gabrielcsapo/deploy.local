import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InboxItem } from '../../shared/v2/contracts.ts';
const root = mkdtempSync(join(tmpdir(), 'v2-inbox-producers-'));
process.env.DEPLOY_DATA_DIR = root;
const { db, list, save } = await import('../workspace/store.ts');
const { createInboxItem, registerInboxAction, answerInbox, syncInbox, withdrawInboxItems } =
  await import('./inbox.ts');
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
const owner = 'gabriel';

test('design differences replace one decision, answers resume the same task, and matches withdraws it', async () => {
  const { reportDesignBuild, taskDesignCheck } = await import('./design-check.ts');
  const who = 'design-owner';
  const taskId = 'tally-builder';
  save('task', who, { id: taskId, projectId: 'tally', status: 'running', revision: 1 });
  save('run', who, { id: 'active', taskId, status: 'running' });
  const reviewId = 'design:tally:header';
  save('v2-inbox-native', who, {
    id: reviewId,
    context: {
      source: 'design',
      taskId,
      projectId: 'tally',
      checkBoards: [
        { file: 'Header.html', title: 'Tally header', widths: [1440, 700], height: 900 },
      ],
    },
    item: {
      ...decision(reviewId),
      projectId: 'tally',
      title: 'A calmer Tally header',
      state: 'answered',
      answer: { actionId: 'approve', at: '2026-11-09T14:14:00Z' },
    },
  });
  save('design-review-landing', who, { id: reviewId, state: 'landed', commit: 'main-commit' });
  const report = {
    state: 'differs',
    differences: 1,
    text: 'History wraps at 700 px.',
    why: 'Five digits need more room.',
    board: 'Header.html',
    width: 700,
  };
  assert.throws(() => reportDesignBuild(who, taskId, { ...report, text: '  ' }), /plain words/);
  assert.throws(
    () => reportDesignBuild(who, taskId, { ...report, text: undefined }),
    /plain words/,
  );
  save('screenshot', who, {
    id: 'wrong',
    taskId: 'another-task',
    image: '/image',
    width: 700,
    height: 900,
  });
  assert.throws(
    () => reportDesignBuild(who, taskId, { ...report, screenshotId: 'wrong' }),
    /this task/,
  );
  save('screenshot', who, { id: 'capture', taskId, image: '/image', width: 700, height: 900 });
  assert.throws(
    () => reportDesignBuild(who, taskId, { ...report, screenshotId: 'capture', width: 1440 }),
    /width/,
  );
  reportDesignBuild(who, taskId, { ...report, screenshotId: 'capture' });
  const decisions = () => syncInbox(who).filter((item) => item.designCheck);
  const first = decisions()[0];
  assert.equal(first.designCheck!.capture!.image, '/image');
  reportDesignBuild(who, taskId, { ...report, text: 'History has its own line.' });
  assert.equal(decisions().length, 1);
  assert.equal(decisions()[0].id, first.id);
  assert.equal(decisions()[0].text, 'History has its own line.');
  assert.equal(
    decisions()[0].designCheck!.capture,
    undefined,
    'replacing the report removes stale captures',
  );
  save('queued-message', who, {
    id: taskId,
    taskId,
    status: 'queued',
    content: 'Keep this earlier instruction.',
  });
  answerInbox(who, first.id, { actionId: 'fix-app', on: 'web' });
  assert.equal(taskDesignCheck(who, taskId)!.state, 'waiting');
  const message = () => list('queued-message', who).find((row) => row.id === taskId)!.content;
  assert.match(message(), /Keep this earlier instruction/);
  assert.match(message(), /Fix the app/);
  assert.match(message(), /History has its own line/);
  assert.throws(() => answerInbox(who, first.id, { actionId: 'keep-design', on: 'web' }), {
    status: 409,
  });
  reportDesignBuild(who, taskId, report);
  const next = decisions().find((item) => item.state === 'waiting')!;
  assert.notEqual(next.id, first.id);
  answerInbox(who, next.id, { actionId: 'keep-design', on: 'web' });
  assert.equal(taskDesignCheck(who, taskId)!.state, 'kept');
  assert.match(message(), /own branch/);
  assert.match(message(), /pull request/);
  assert.equal(list('task', who).length, 1);
  reportDesignBuild(who, taskId, report);
  const waiting = decisions().find((item) => item.state === 'waiting')!;
  reportDesignBuild(who, taskId, { state: 'matches', captures: 2 });
  assert.equal(taskDesignCheck(who, taskId)!.state, 'matches');
  assert.equal(taskDesignCheck(who, taskId)!.captures, 2);
  assert.equal(taskDesignCheck(who, taskId)!.text, undefined);
  assert.equal(decisions().find((item) => item.id === waiting.id)!.state, 'withdrawn');
  assert.equal(decisions().filter((item) => item.state === 'waiting').length, 0);
  assert.equal(decisions().filter((item) => item.state === 'answered').length, 2);
  assert.throws(() => answerInbox(who, waiting.id, { actionId: 'fix-app', on: 'web' }), {
    status: 409,
  });
  reportDesignBuild(who, taskId, {
    state: 'matches',
    captures: 1,
    comparisons: [{ board: 'Header.html', width: 700, screenshotId: 'capture' }],
  });
  assert.deepEqual(taskDesignCheck(who, taskId)!.comparisons, [
    { board: 'Header.html', width: 700, screenshotId: 'capture', image: '/image', height: 900 },
  ]);
  assert.throws(
    () =>
      reportDesignBuild(who, taskId, {
        state: 'matches',
        comparisons: [{ board: 'Header.html', width: 700, screenshotId: 'wrong' }],
      }),
    /this task/,
  );
});
function decision(id: string): InboxItem {
  return {
    id,
    kind: 'other',
    from: 'warden',
    projectId: 'gym',
    title: 'Continue?',
    text: 'Review work',
    createdAt: new Date().toISOString(),
    state: 'waiting',
    actions: ['execute', 'keep', 'dismiss', 'not-now'].map((id) => ({ id, label: id })),
  };
}

test('one native store, private context, missing handlers leave decisions waiting', () => {
  const item = createInboxItem(owner, decision('missing'), { secret: 'private' });
  assert.deepEqual(createInboxItem(owner, { ...item, title: 'Changed' }, {}), item);
  assert.throws(() => answerInbox(owner, item.id, { actionId: 'execute', on: 'web' }), {
    status: 501,
  });
  assert.equal(syncInbox(owner).find((i) => i.id === item.id)!.state, 'waiting');
  assert.equal(list('v2-inbox-answer', owner).length, 0);
  assert.equal(list('v2-inbox-produced', owner).length, 0);
  assert.equal(list('v2-inbox-native', owner).length, 1);
  assert(!JSON.stringify(syncInbox(owner)).includes('secret'));
  assert(
    !JSON.stringify(db.prepare("SELECT payload FROM events WHERE type='v2.inbox'").all()).includes(
      'secret',
    ),
  );
});

test('keep, dismiss and Not now need no handler and remain first-answer-wins', () => {
  for (const actionId of ['keep', 'dismiss', 'not-now']) {
    const item = createInboxItem(owner, decision(actionId), {});
    const answer = answerInbox(owner, item.id, { actionId, on: 'desktop' });
    assert.equal(answer.state, 'answered');
    assert.equal(answer.answer?.actionId, actionId);
    assert.deepEqual(createInboxItem(owner, item, { changed: true }), answer);
    assert.throws(() => answerInbox(owner, item.id, { actionId, on: 'cli' }), { status: 409 });
  }
});

test('unregister does not remove a newer handler; handler failures save no answer', () => {
  const item = createInboxItem(owner, decision('registered'), { token: 'private' });
  const old = registerInboxAction('other', () => assert.fail('old handler'));
  let calls = 0;
  const unregister = registerInboxAction('other', (who, current, body, context) => {
    assert.equal(who, owner);
    assert.equal(current.id, item.id);
    assert.equal(body.actionId, 'execute');
    assert.equal(context.token, 'private');
    calls++;
    throw new Error('Cannot enqueue');
  });
  old();
  assert.throws(
    () => answerInbox(owner, item.id, { actionId: 'execute', on: 'web' }),
    /Cannot enqueue/,
  );
  assert.equal(calls, 1);
  assert.equal(syncInbox(owner).find((i) => i.id === item.id)!.state, 'waiting');
  unregister();
  assert.throws(() => answerInbox(owner, item.id, { actionId: 'execute', on: 'web' }), {
    status: 501,
  });
  withdrawInboxItems(owner, 'gym', 'other');
  assert.equal(syncInbox(owner).find((i) => i.id === item.id)!.state, 'withdrawn');
  assert.throws(() => answerInbox(owner, item.id, { actionId: 'keep', on: 'web' }), {
    status: 409,
  });
});

test('menu bar provenance is additive and validated separately from the desktop client', () => {
  createInboxItem(owner, decision('menu-bar'), {});
  assert.throws(
    () => answerInbox(owner, 'menu-bar', { actionId: 'keep', on: 'web', surface: 'menu-bar' }),
    /desktop source/,
  );
  const item = answerInbox(owner, 'menu-bar', {
    actionId: 'keep',
    on: 'desktop',
    surface: 'menu-bar',
  });
  assert.equal(item.answer?.surface, 'menu-bar');
  assert.equal(item.answer?.on, 'desktop');
});

test('questions include only the latest non-progress task reply and owner-scoped names', () => {
  const who = 'question-reader';
  const createdAt = '2026-11-03T12:00:00.000Z';
  save('task', who, { id: 'task', projectId: 'project', status: 'running' });
  save('project', who, { id: 'project', name: 'home-gym' });
  save('agent', who, { id: 'custom-id', name: 'Release notes writer' });
  save('run', who, { id: 'run', taskId: 'task', agentId: 'custom-id' });
  save('question', who, {
    id: 'draft',
    taskId: 'task',
    runId: 'run',
    question: 'Publish?',
    options: ['Do not publish'],
    status: 'pending',
    createdAt,
  });
  const message = {
    id: 'draft-message',
    taskId: 'task',
    role: 'assistant',
    content: '# Draft\n\n- Ready',
    createdAt,
  };
  save('message', who, message);
  // Insertion order is not message order. Ignore progress, user, tool and other task replies.
  save('message', who, {
    ...message,
    id: 'older',
    content: 'Old',
    createdAt: '2026-11-02T12:00:00.000Z',
  });
  for (const [id, changes] of Object.entries({
    progress: { isProgress: true },
    user: { role: 'user' },
    tool: { role: 'tool' },
    other: { taskId: 'other' },
    blank: { content: '  ' },
  }))
    save('message', who, { ...message, id, createdAt: '2026-11-03T12:01:00.000Z', ...changes });
  save('message', 'another-owner', {
    ...message,
    id: 'private',
    content: 'Private',
    createdAt: '2026-11-04T12:00:00.000Z',
  });
  save('agent', 'another-owner', { id: 'custom-id', name: 'Private agent' });
  const item = syncInbox(who)[0];
  assert.equal(item.fromName, 'Release notes writer');
  assert.equal(item.projectName, 'home-gym');
  assert.deepEqual(item.context, { text: message.content, messageId: message.id, createdAt });
  assert.equal(item.actions[0].primary, true);
  const eventsBefore = db
    .prepare("SELECT payload FROM events WHERE owner=? AND type='v2.inbox' ORDER BY cursor")
    .all(who) as { payload: string }[];
  assert.deepEqual(JSON.parse(eventsBefore.at(-1)!.payload).item.context, item.context);
  syncInbox(who);
  assert.equal(
    (
      db.prepare("SELECT count(*) AS n FROM events WHERE owner=? AND type='v2.inbox'").get(who) as {
        n: number;
      }
    ).n,
    eventsBefore.length,
  );
  save('message', who, {
    ...message,
    id: 'revised',
    content: '**Revised**',
    createdAt: '2026-11-03T12:02:00.000Z',
  });
  assert.equal(syncInbox(who)[0].context?.text, '**Revised**');
});

test('missing replies and non-question decisions have null context; names never fall back to ids', () => {
  const who = 'empty-question';
  const createdAt = '2026-11-03T12:00:00.000Z';
  save('task', who, { id: 'task', status: 'running' });
  for (const agentId of ['scout', 'warden', 'deleted-agent']) {
    save('run', who, { id: agentId, taskId: 'task', agentId });
    save('question', who, {
      id: agentId,
      taskId: 'task',
      runId: agentId,
      question: 'Continue?',
      options: [],
      status: 'pending',
      createdAt,
    });
  }
  const items = syncInbox(who);
  assert.deepEqual(
    new Set(items.map((item) => item.fromName)),
    new Set(['Scout', 'Warden', 'An agent']),
  );
  assert(items.every((item) => item.context === null && item.projectName === undefined));
  createInboxItem(who, { ...decision('no-task'), kind: 'question' }, {});
  createInboxItem(who, { ...decision('not-question'), taskId: 'task' }, {});
  save('message', who, {
    id: 'reply',
    taskId: 'task',
    role: 'assistant',
    content: 'Draft',
    createdAt,
  });
  assert.equal(syncInbox(who).find((item) => item.id === 'no-task')!.context, null);
  assert.equal(syncInbox(who).find((item) => item.id === 'not-question')!.context, null);
});
