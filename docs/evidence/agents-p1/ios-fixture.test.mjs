import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { boards, createFixtureHandler } from './ios-fixture-server.mjs';

// Exercise the real HTTP handler without opening a port or reaching any service.
function fixture() {
  const handle = createFixtureHandler();
  return async (url, { method = 'GET', body, token = 'fixture-only' } = {}) => {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    Object.assign(req, { url, method, headers: { 'x-deploy-token': token } });
    let status;
    let result;
    await handle(req, {
      writeHead(code) {
        status = code;
      },
      end(text) {
        result = JSON.parse(text);
      },
    });
    return { status, data: result };
  };
}
const select = (request, board) => request('/fixture/board', { method: 'POST', body: { board } });

test('every capture board resets state and supplies required native snapshot fields', async () => {
  const request = fixture();
  assert.equal(boards.length, 19);
  for (const board of boards) {
    assert.equal((await select(request, board)).data.board, board);
    const { data: agents } = await request('/api/v2/agents');
    assert.equal(agents.agents.length, board === 'WorkNoAgentsPhone' ? 0 : 5, board);
    assert.ok(agents.agents.every((agent) => agent.avatar.glyph && agent.avatar.color));
    const { data: workspace } = await request('/api/workspace/state');
    assert.equal(workspace.cursor, 0);
    assert.equal(workspace.projects.length, 5);
    assert.deepEqual(
      workspace.workers.map((worker) => worker.name),
      ['SER', 'bazzite'],
    );
    for (const task of workspace.tasks) {
      assert.equal(typeof task.revision, 'number');
      assert.ok(task.createdAt && task.updatedAt && task.workspacePath && task.baseRevision);
    }
    const { data: live } = await request('/api/v2/live');
    assert.equal(live.summary.warning, 0);
    assert.ok(live.summary.checkedAt);
    assert.equal((await request('/api/user')).data.role, 'admin');
    assert.equal((await request('/api/v2/inbox')).data.items.length, 0);
  }
  assert.equal((await select(request, 'UnknownPhone')).status, 400);
  assert.equal((await request('/fixture/board')).data.board, 'TaskMentionPhone');
  assert.equal((await request('/api/v2/agents', { token: 'real-token' })).status, 401);
  assert.equal((await request('/api/execute', { method: 'POST', body: {} })).status, 404);
});

test('hello, taught, beat and item/history scenarios preserve phase-1 content', async () => {
  const request = fixture();
  await select(request, 'AgentHelloPhone');
  const empty = (await request('/api/v2/agents')).data.agents[0];
  assert.equal(empty.job, '');
  assert.deepEqual(empty.looksAfter, []);
  assert.equal(
    (await request('/api/v2/agents/release-notes-writer/conversation')).data.events.length,
    0,
  );
  assert.ok((await request('/api/v2/approvals')).data.rules.every((rule) => rule.mode === 'ask'));
  await select(request, 'AgentTaughtPhone');
  const taught = (await request('/api/v2/agents/release-notes-writer/conversation')).data.events;
  assert.deepEqual(
    taught[1].receipts.map((receipt) => receipt.kind),
    ['looks-after'],
  );
  const itemPath = '/api/v2/agents/release-notes-writer/items/draft-release-notes';
  assert.equal(
    (await request('/api/v2/agents')).data.agents[0].looksAfter[0].confirmedAt,
    undefined,
  );
  await request(itemPath + '/confirm', { method: 'POST', body: {} });
  assert.ok((await request('/api/v2/agents')).data.agents[0].looksAfter[0].confirmedAt);
  await select(request, 'AgentTaughtPhone');
  assert.equal(
    (await request('/api/v2/agents')).data.agents[0].looksAfter[0].confirmedAt,
    undefined,
  );
  await select(request, 'AgentRoutinePhone');
  assert.match(
    (await request('/api/v2/agents')).data.agents[0].looksAfter[0].what,
    /Send the draft here/,
  );
  await select(request, 'AgentBeatProjectsPhone');
  const reviewer = (await request('/api/v2/agents')).data.agents[2];
  assert.deepEqual(reviewer.looksAfter[0].where.projects, ['home-gym', 'tally', 'deploy.local']);
  assert.equal(reviewer.looksAfter[0].confirmedAt, undefined);
  assert.match(
    (await request('/api/v2/agents/code-reviewer/conversation')).data.events[1].paragraphs[1],
    /recipes/,
  );
  await select(request, 'AgentRunsPhone');
  assert.deepEqual(
    (await request(itemPath + '/runs')).data.runs.map((run) => run.title),
    ['No new merges this week', 'Drafted notes for 3 changes'],
  );
});

test('native rules remain decodable and retain the full canonical rule set', async () => {
  const request = fixture();
  assert.equal((await request('/fixture/state')).data.rules.length, 45);
  const { data: approvals } = await request('/api/v2/approvals');
  assert.equal(approvals.rules.length, 25);
  assert.ok(
    approvals.rules.every((rule) =>
      ['start-task', 'open-pull-request', 'merge', 'restart', 'rollback'].includes(rule.action),
    ),
  );
  assert.equal(approvals.rules[0].mode, 'allow');
  approvals.rules[0].mode = 'never';
  await request('/api/v2/approvals', { method: 'PUT', body: approvals });
  assert.equal((await request('/fixture/state')).data.rules.length, 45);
  assert.equal((await request('/api/v2/approvals')).data.rules[0].mode, 'never');
  await select(request, 'AgentRulesPhone');
  assert.equal((await request('/api/v2/approvals')).data.rules[0].mode, 'allow');
});

test('TaskMention supplies both board sync task and canonical Tally task, typed events and diff', async () => {
  const request = fixture();
  await select(request, 'TaskMentionPhone');
  assert.deepEqual(
    (await request('/api/workspace/state')).data.tasks.map((task) => task.id),
    ['last-updated-time', 'sync'],
  );
  const { data: detail } = await request('/api/workspace/tasks/sync');
  assert.equal(detail.task.title, 'Fix the sync worker');
  assert.equal(detail.runs[0].status, 'running');
  assert.equal(detail.runs[0].adapter, 'codex');
  assert.deepEqual(detail.messages, []);
  const { data: events } = await request('/api/v2/events?after=0');
  assert.deepEqual(
    events.events.filter((event) => event.taskId === 'sync').map((entry) => entry.event.kind),
    ['you', 'worklog'],
  );
  assert.ok(events.events.every((event, i) => event.cursor === i + 1));
  const { data: diff } = await request('/api/workspace/tasks/sync/diff');
  assert.ok(diff.baseRevision && diff.headRevision && diff.status);
  assert.equal(diff.files[0].path, 'src/sync/workouts.ts');
  assert.equal((await request('/api/v2/tasks/last-updated-time')).data.task.projectId, 'tally');
});
