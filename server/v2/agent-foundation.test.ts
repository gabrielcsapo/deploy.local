import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const root = mkdtempSync(join(tmpdir(), 'agents-foundation-'));
process.env.DEPLOY_DATA_DIR = root;
const { db, save, list, events, event } = await import('../workspace/store.ts');
const {
  agentsForOwner,
  createAgent,
  patchAgent,
  confirmAgentItem,
  saveAgentReply,
  agentConversation,
} = await import('./agents.ts');
const { validateAvatar, validateItem, nextItemAt, itemProjects } =
  await import('./agent-foundation.ts');
const { agentColors, agentGlyphs, avatarFromId } = await import('../../shared/v2/agents.ts');
const { tickAgentSchedules, agentRuns } = await import('./agent-runs.ts');
const { sendAgentMessage } = await import('./attachments.ts');
const { saveProviderConnection } = await import('../workspace/provider-connections.ts');
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
const item = (id = randomUUID()) => ({
  id,
  what: 'Draft release notes',
  where: 'all-active' as const,
  when: { every: 'week' as const, day: 5, time: '16:00', timezone: 'America/New_York' },
  brings: 'message' as const,
});
test('name-only creation, stable identity, legacy migration and retained fields', () => {
  const owner = randomUUID();
  const created = createAgent(owner, {
    name: '  Notes  ',
    avatar: { glyph: 'variant28', color: '#af61f2' },
  });
  assert.equal(created.name, 'Notes');
  assert.equal(created.job, '');
  assert.deepEqual(created.looksAfter, []);
  assert.deepEqual(patchAgent(owner, created.id, { name: 'New name' }).avatar, created.avatar);
  assert.throws(() => createAgent(owner, { name: ' ' }));
  save('agent', owner, {
    id: 'legacy',
    name: 'Old',
    job: 'Watch apps\nAsk first',
    computers: [],
    schedule: { enabled: true, time: '09:15' },
    triggers: { mention: false, disk: true },
    apps: ['a'],
    createdBy: owner,
  });
  const first = agentsForOwner(owner).find((a) => a.id === 'legacy')!;
  assert.deepEqual(first.avatar, avatarFromId('legacy'));
  assert.equal(first.looksAfter?.[0].what, 'Watch apps');
  assert.equal(first.looksAfter?.[0].when.every, 'day');
  assert.ok(first.looksAfter?.[0].confirmedAt);
  const count = events(owner).length;
  assert.deepEqual(agentsForOwner(owner), agentsForOwner(owner));
  assert.equal(events(owner).length, count);
  const patched = patchAgent(owner, 'legacy', { job: 'New job' });
  assert.deepEqual(patched.apps, ['a']);
  assert.deepEqual(patched.triggers, { mention: false, disk: true });
  assert.equal(agentsForOwner('other').length, 0);
});
test('only the 35 glyphs and ten colors validate; invalid item fields reject', () => {
  for (const glyph of agentGlyphs)
    for (const color of agentColors)
      assert.deepEqual(validateAvatar({ glyph, color }), { glyph, color });
  for (const avatar of [
    { glyph: 'variant36', color: '#af61f2' },
    { glyph: 'variant01', color: '#ffffff' },
    null,
  ])
    assert.throws(() => validateAvatar(avatar));
  for (const invalid of [
    { ...item(), when: { ...item().when, day: 7 } },
    { ...item(), when: { ...item().when, timezone: 'Moon' } },
    { ...item(), when: { ...item().when, time: '24:00' } },
    { ...item(), where: { projects: [] } },
    { ...item(), brings: 'ship' },
  ])
    assert.throws(() => validateItem(invalid));
});
test('teaching is atomic, receipts are stored, uncertain and invalid replies cannot change instructions', () => {
  const owner = randomUUID();
  const agent = createAgent(owner, { name: 'Notes' });
  const taught = {
    reply: 'I saved the job. Confirm the item before it starts.',
    job: 'Draft notes and ask before publishing.',
    item: item(),
  };
  saveAgentReply(
    owner,
    agent,
    'Every Friday draft notes',
    JSON.stringify(taught),
    [],
    undefined,
    'op',
  );
  const updated = agentsForOwner(owner)[0];
  assert.equal(updated.job, taught.job);
  assert.equal(updated.looksAfter?.length, 1);
  assert.equal(updated.looksAfter?.[0].confirmedAt, undefined);
  const reply = agentConversation(owner, agent.id).find((e) => e.kind === 'reply');
  assert.deepEqual(reply?.kind === 'reply' && reply.receipts?.map((r) => r.kind), ['looks-after']);
  saveAgentReply(
    owner,
    agent,
    'Every Friday draft notes',
    JSON.stringify(taught),
    [],
    undefined,
    'op',
  );
  assert.equal(agentConversation(owner, agent.id).length, 2);
  saveAgentReply(
    owner,
    updated,
    'Maybe watch something',
    JSON.stringify({ reply: 'Which projects?', job: null, item: null }),
  );
  assert.equal(agentsForOwner(owner)[0].job, taught.job);
  assert.throws(() =>
    saveAgentReply(
      owner,
      updated,
      'Bad',
      JSON.stringify({ reply: 'Saved', job: 'Wrong', item: { ...item(), brings: 'ship' } }),
    ),
  );
  assert.equal(agentsForOwner(owner)[0].job, taught.job);
  assert.equal(agentsForOwner(owner)[0].looksAfter?.length, 1);
});
test('confirmation is owner-scoped and idempotent; changing an item requires reconfirmation', () => {
  const owner = randomUUID();
  const draft = item();
  const agent = createAgent(owner, {
    name: 'Notes',
    looksAfter: [{ ...draft, confirmedAt: '2020-01-01T00:00:00Z' }],
  });
  assert.equal(agent.looksAfter?.[0].confirmedAt, undefined);
  assert.throws(() => confirmAgentItem('other', agent.id, draft.id), /not found/i);
  const confirmed = confirmAgentItem(owner, agent.id, draft.id);
  assert.ok(confirmed.looksAfter?.[0].confirmedAt);
  assert.equal(agentRuns(owner, agent.id).length, 0);
  assert.deepEqual(confirmAgentItem(owner, agent.id, draft.id), confirmed);
  const edited = patchAgent(owner, agent.id, {
    looksAfter: [{ ...confirmed.looksAfter![0], what: 'Review code' }],
  });
  assert.equal(edited.looksAfter?.[0].confirmedAt, undefined);
  assert.throws(() => patchAgent(owner, agent.id, { looksAfter: [draft, draft] }), /Duplicate/);
});
test('weekly timezones, daily DST, and scope intersect current access', () => {
  assert.equal(
    nextItemAt(
      { ...item(), confirmedAt: '2026-10-30T21:00:00Z' },
      new Date('2026-10-30T21:00:00Z'),
    ),
    '2026-11-06T21:00:00.000Z',
  );
  const daily = {
    ...item(),
    confirmedAt: '2026-10-31T20:00:00Z',
    when: { every: 'day' as const, time: '08:00', timezone: 'America/New_York' },
  };
  assert.equal(nextItemAt(daily, new Date('2026-10-31T20:00:00Z')), '2026-11-01T13:00:00.000Z');
  const owner = randomUUID();
  save('project', owner, { id: 'one', name: 'One' });
  save('project', owner, { id: 'two', name: 'Two' });
  save('project', 'other', { id: 'secret' });
  const agent = createAgent(owner, { name: 'Notes', projectId: 'one' });
  assert.deepEqual(
    itemProjects(owner, agent, item()).map((p) => p.id),
    ['one'],
  );
  assert.deepEqual(
    itemProjects(owner, agent, { ...item(), where: { projects: ['two', 'secret'] } }),
    [],
  );
  assert.throws(() => patchAgent(owner, agent.id, { projectId: 'secret' }), /not found/i);
});
test('scheduler waits for confirmed items, attributes runs per item, and observes project changes', () => {
  const owner = randomUUID();
  save('worker', owner, { id: 'ser', name: 'SER', heartbeat: new Date().toISOString() });
  const draft = { ...item(), when: { every: 'day' as const, time: '08:00', timezone: 'UTC' } };
  const agent = createAgent(owner, {
    name: 'Notes',
    job: 'Ask before publishing.',
    looksAfter: [draft],
  });
  const rule = list('v2-approval', owner).find(
    (r) => r.agent === agent.id && r.action === 'start-task',
  );
  save('v2-approval', owner, { ...rule, mode: 'allow' });
  tickAgentSchedules(new Date('2027-01-02T09:00:00Z'));
  assert.equal(agentRuns(owner, agent.id).length, 0);
  save('agent', owner, {
    ...agent,
    looksAfter: [{ ...draft, confirmedAt: '2027-01-02T09:00:00Z' }],
  });
  tickAgentSchedules(new Date('2027-01-02T09:01:00Z'));
  assert.equal(agentRuns(owner, agent.id).length, 0);
  tickAgentSchedules(new Date('2027-01-03T08:00:00Z'));
  assert.equal(agentRuns(owner, agent.id, draft.id).length, 1);
  tickAgentSchedules(new Date('2027-01-03T08:10:00Z'));
  assert.equal(agentRuns(owner, agent.id).length, 1);
  save('project', owner, { id: 'p', name: 'Project' });
  const change = {
    ...item(),
    when: { every: 'change' as const, time: '08:00', timezone: 'UTC' },
    confirmedAt: '2020-01-01T00:00:00Z',
  };
  const watcher = createAgent(owner, { name: 'Watcher' });
  save('agent', owner, { ...watcher, looksAfter: [change] });
  tickAgentSchedules();
  assert.equal(list('v2-inbox-native', owner).filter((r) => r.item.from === watcher.id).length, 0);
  event(owner, '', null, 'project.updated', { projectId: 'p' });
  tickAgentSchedules();
  assert.equal(list('v2-inbox-native', owner).filter((r) => r.item.from === watcher.id).length, 1);
});
test('composer uses selected compatible model and structured teaching, without tools', async () => {
  const owner = randomUUID();
  save('worker', owner, { id: 'w' });
  saveProviderConnection(owner, {
    workerId: 'w',
    provider: 'compatible',
    enabled: true,
    mode: 'api-key',
    baseUrl: 'https://model.example/v1',
    model: 'fixture',
    billingMode: 'local',
  });
  const agent = createAgent(owner, { name: 'Notes' });
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.response_format.type, 'json_object');
    assert.equal(body.tools, undefined);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                reply: 'What should I look after?',
                job: null,
                item: null,
              }),
            },
          },
        ],
      }),
    );
  };
  try {
    const result = await sendAgentMessage(owner, agent.id, { text: 'Hello', operationId: 'hello' });
    assert.equal(result.events.length, 2);
    assert.equal(list('task', owner).length, 0);
  } finally {
    globalThis.fetch = original;
  }
});
