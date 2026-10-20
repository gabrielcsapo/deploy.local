import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DEPLOY_DATA_DIR = mkdtempSync(join(tmpdir(), 'deploy-controls-test-'));
const { get, save, list, id } = await import('./store.ts');
const {
  interactiveOperator: operator,
  interactiveWorker: worker,
  interactiveRead: read,
  interactiveTool: tool,
  pendingControlRequests: pending,
} = await import('./interactive.ts');
const targets = [
  { id: 'managed-browser', kind: 'browser', label: 'Task browser', available: true },
];
function fixture() {
  const owner = id(),
    taskId = id(),
    clientId = id(),
    instanceId = id();
  save('task', owner, { id: taskId });
  const poll = (extra = {}) => worker(owner, 'local', 'poll', { instanceId, targets, ...extra });
  poll();
  const act = (action: string, extra: any = {}) =>
    operator(owner, taskId, action, { operationId: id(), clientId, ...extra });
  const session = act('open', { workerId: 'local', targetId: 'managed-browser' });
  poll({ ready: [{ id: session.id, generation: session.generation }] });
  const scope = { owner, taskId, runId: id() };
  save('run', owner, { id: scope.runId, taskId, status: 'running' });
  const send = (extra: any = {}) =>
    act('input', {
      sessionId: session.id,
      generation: session.generation,
      action: { type: 'inspect' },
      ...extra,
    });
  const claim = (entry: any) =>
    worker(owner, 'local', 'claim', {
      instanceId,
      sessionId: session.id,
      commandId: entry.id,
      generation: entry.generation,
    });
  return { owner, taskId, clientId, instanceId, poll, act, session, scope, send, claim };
}
test('agent cannot grant itself control; grants are scoped to task and controller', () => {
  const f = fixture();
  assert.throws(
    () =>
      tool(f.scope, {
        action: 'input',
        sessionId: f.session.id,
        generation: f.session.generation,
        input: { type: 'inspect' },
        operationId: id(),
      }),
    /Take control/,
  );
  const other = id();
  save('task', f.owner, { id: other });
  assert.throws(
    () =>
      operator(f.owner, other, 'stop', {
        operationId: id(),
        clientId: f.clientId,
        sessionId: f.session.id,
      }),
    /another task/,
  );
  assert.throws(() => f.send({ clientId: id() }), /Take control/);
  const transfer = f.act('release', { sessionId: f.session.id, generation: f.session.generation });
  assert.equal(transfer.status, 'transferring');
  assert.throws(
    () =>
      tool(f.scope, {
        action: 'input',
        sessionId: transfer.id,
        generation: transfer.generation,
        input: { type: 'inspect' },
        operationId: id(),
      }),
    /Take control/,
  );
  f.poll({ ready: [{ id: transfer.id, generation: transfer.generation }] });
  const entry = tool(f.scope, {
    action: 'input',
    sessionId: transfer.id,
    generation: transfer.generation,
    input: { type: 'inspect' },
    operationId: id(),
  });
  assert.equal(entry.status, 'queued');
});
test('takeover cancels queued input and stale commands cannot claim; duplicate input is not replayed', () => {
  const f = fixture();
  const operationId = id();
  const entry = f.send({ operationId });
  assert.equal(f.send({ operationId }).id, entry.id);
  const takeover = f.act('takeover', {
    sessionId: f.session.id,
    generation: f.session.generation,
    clientId: id(),
  });
  assert.notEqual(takeover.generation, f.session.generation);
  assert.equal(get('interactive-command', f.owner, entry.id).status, 'cancelled');
  assert.throws(() => f.claim(entry), /no longer execute/);
  assert.throws(() => f.send(), /Take control/);
});
test('stop fences a command in flight and late result cannot revive the session', () => {
  const f = fixture(),
    entry = f.send();
  f.claim(entry);
  assert.throws(() => f.claim(entry), /no longer execute/);
  f.act('stop', { sessionId: f.session.id });
  const response = worker(f.owner, 'local', 'complete', {
    instanceId: f.instanceId,
    sessionId: f.session.id,
    commandId: entry.id,
    generation: entry.generation,
    snapshot: { text: 'late' },
  });
  assert.equal(response.accepted, false);
  assert.equal(get('interactive-session', f.owner, f.session.id).status, 'stopped');
  assert.equal(get('interactive-command', f.owner, entry.id).status, 'unknown');
  assert.equal(list('interactive-snapshot', f.owner).length, 0);
});
test('restart, lease expiry, and lost permission suspend control without reassigning input', () => {
  for (const cause of ['restart', 'timeout', 'permission']) {
    const f = fixture(),
      entry = f.send();
    if (cause === 'restart') f.poll({ instanceId: id() });
    if (cause === 'timeout') {
      save('interactive-session', f.owner, {
        ...get('interactive-session', f.owner, f.session.id),
        heartbeat: new Date(Date.now() - 10000).toISOString(),
      });
      read(f.owner, f.taskId);
    }
    if (cause === 'permission') f.poll({ targets: [{ ...targets[0], available: false }] });
    assert.equal(get('interactive-session', f.owner, f.session.id).status, 'suspended');
    assert.equal(get('interactive-command', f.owner, entry.id).status, 'cancelled');
    assert.equal(f.poll().commands.length, 0);
  }
});
test('uncertain result suspends; completed run cannot begin previously queued agent input', () => {
  const f = fixture(),
    entry = f.send();
  f.claim(entry);
  worker(f.owner, 'local', 'complete', {
    instanceId: f.instanceId,
    sessionId: f.session.id,
    commandId: entry.id,
    generation: entry.generation,
    error: 'Response lost after click',
  });
  assert.equal(get('interactive-command', f.owner, entry.id).status, 'unknown');
  assert.equal(get('interactive-session', f.owner, f.session.id).status, 'suspended');
  const g = fixture();
  const transfer = g.act('release', { sessionId: g.session.id, generation: g.session.generation });
  g.poll({ ready: [{ id: transfer.id, generation: transfer.generation }] });
  const pending = tool(g.scope, {
    action: 'input',
    sessionId: transfer.id,
    generation: transfer.generation,
    input: { type: 'inspect' },
    operationId: id(),
  });
  save('run', g.owner, { id: g.scope.runId, status: 'interrupted' });
  assert.equal(g.claim(pending).status, 'cancelled');
  assert.equal(get('interactive-command', g.owner, pending.id).status, 'cancelled');
  assert.equal(g.poll().commands.length, 0);
});
test('unsafe URLs, invalid coordinates, and unrelated worker credentials are rejected', () => {
  const f = fixture();
  assert.throws(() => f.send({ action: { type: 'navigate', url: 'file:///etc/passwd' } }), /HTTP/);
  assert.throws(
    () => f.send({ action: { type: 'navigate', url: 'https://name:secret@example.com' } }),
    /HTTP/,
  );
  assert.throws(() => f.send({ action: { type: 'click', x: -1, y: 12 } }), /selector/);
  save('worker', f.owner, { id: 'other', instanceId: 'other-instance' });
  assert.throws(
    () =>
      worker(f.owner, 'other', 'fail', { instanceId: 'other-instance', sessionId: f.session.id }),
    /not assigned/,
  );
  assert.throws(
    () => worker(f.owner, 'other', 'poll', { instanceId: 'stale', targets }),
    /changed/,
  );
});

test('one local desktop controller across account boundaries', () => {
  const first = fixture(),
    second = fixture();
  const desktop = [
    { id: 'display-1', kind: 'computer', label: 'Mac main display', available: true },
  ];
  first.poll({ targets: desktop });
  second.poll({ targets: desktop });
  const opened = first.act('open', { workerId: 'local', targetId: 'display-1' });
  assert.throws(
    () => second.act('open', { workerId: 'local', targetId: 'display-1' }),
    /already has a control session/,
  );
  first.act('stop', { sessionId: opened.id });
  const secondSession = second.act('open', { workerId: 'local', targetId: 'display-1' });
  assert.equal(secondSession.status, 'opening');
  second.act('stop', { sessionId: secondSession.id });
});

test('window inventory survives reordering with more than ten desktop targets', () => {
  const f = fixture();
  const windows = Array.from({ length: 50 }, (_, index) => ({
    id: `window-${index}-42`,
    kind: 'computer',
    label: `Window ${index}`,
    available: true,
  }));
  f.poll({ targets: windows });
  const opened = f.act('open', { workerId: 'local', targetId: 'window-49-42' });
  f.poll({
    targets: [...windows].reverse(),
    ready: [{ id: opened.id, generation: opened.generation }],
  });
  assert.equal(get('interactive-session', f.owner, opened.id).status, 'active');
  f.poll({ targets: windows.filter((window) => window.id !== opened.targetId) });
  assert.equal(get('interactive-session', f.owner, opened.id).status, 'suspended');
});

test('agent catalog omits unopened desktop targets and malformed input cannot queue', () => {
  const f = fixture();
  f.poll({
    targets: [
      ...targets,
      { id: 'private-window', kind: 'computer', label: 'Unopened private window', available: true },
    ],
  });
  const state = tool(f.scope, { action: 'list' });
  assert.deepEqual(Object.keys(state), ['sessions', 'requests']);
  assert.equal(state.sessions[0].id, f.session.id);
  assert.doesNotMatch(JSON.stringify(state), /Unopened private window/);
  assert.throws(
    () => tool(f.scope, { action: 'read', sessionId: 'Task browser' }),
    /exact session id/,
  );
  assert.throws(
    () => tool(f.scope, { action: 'input', sessionId: f.session.id }),
    /generation.*operationId.*input/,
  );
  assert.equal(read(f.owner, f.taskId).commands.length, 0);
});

test('agent requests an exact window; approval is required and binds target and worker', () => {
  const f = fixture();
  const args = {
    action: 'request',
    workerId: 'local',
    targetId: 'managed-browser',
    operationId: id(),
  };
  assert.equal(tool(f.scope, { action: 'targets' }).targets[0].id, 'managed-browser');
  const request = tool(f.scope, args);
  assert.equal(request.status, 'pending');
  assert.equal(tool(f.scope, args).id, request.id);
  assert.equal(tool(f.scope, { ...args, operationId: id() }).id, request.id);
  assert.equal(read(f.owner, f.taskId).sessions.length, 1);
  // The task shows it is waiting on you until the request is answered.
  const waiting = pending(f.owner).get(f.taskId);
  assert.equal(waiting?.id, request.id);
  assert.equal(waiting?.targetLabel, 'Task browser');
  const approved = f.act('approve', {
    requestId: request.id,
    workerId: 'ignored',
    targetId: 'ignored',
  });
  assert.equal(approved.targetId, 'managed-browser');
  assert.equal(approved.controlOwner, 'agent');
  assert.equal(approved.status, 'opening');
  assert.equal(tool(f.scope, { action: 'list' }).requests[0].sessionId, approved.id);
  assert.throws(() => f.act('approve', { requestId: request.id }), /no longer pending/);
  assert.equal(pending(f.owner).has(f.taskId), false);
});

test('a request from a finished run no longer marks the task as waiting', () => {
  const f = fixture();
  tool(f.scope, {
    action: 'request',
    workerId: 'local',
    targetId: 'managed-browser',
    operationId: id(),
  });
  assert.equal(pending(f.owner).has(f.taskId), true);
  save('run', f.owner, { ...get('run', f.owner, f.scope.runId), status: 'succeeded' });
  assert.equal(pending(f.owner).has(f.taskId), false);
});

test('access requests cannot cross tasks or survive denial, expiry, or worker replacement', () => {
  for (const cause of ['task', 'denial', 'expiry', 'worker', 'target']) {
    const f = fixture();
    const request = tool(f.scope, {
      action: 'request',
      workerId: 'local',
      targetId: 'managed-browser',
      operationId: id(),
    });
    if (cause === 'task') {
      const taskId = id();
      save('task', f.owner, { id: taskId });
      assert.throws(
        () =>
          operator(f.owner, taskId, 'approve', {
            requestId: request.id,
            clientId: f.clientId,
            operationId: id(),
          }),
        /another task/,
      );
      continue;
    }
    if (cause === 'denial') f.act('deny', { requestId: request.id });
    if (cause === 'expiry')
      save('interactive-request', f.owner, { ...request, expiresAt: Date.now() - 1 });
    if (cause === 'worker') f.poll({ instanceId: id() });
    if (cause === 'target') f.poll({ targets: [] });
    assert.throws(
      () => f.act('approve', { requestId: request.id }),
      /pending|Worker changed|unavailable/,
    );
    assert.equal(read(f.owner, f.taskId).sessions.length, 1);
  }
});

test('desktop input before inspection is recoverable and queues nothing', () => {
  const f = fixture();
  f.poll({
    targets: [{ id: 'window-test', kind: 'computer', label: 'Disposable window', available: true }],
  });
  const session = f.act('open', { workerId: 'local', targetId: 'window-test' });
  f.poll({
    targets: [{ id: 'window-test', kind: 'computer', label: 'Disposable window', available: true }],
    ready: [{ id: session.id, generation: session.generation }],
  });
  assert.throws(
    () =>
      f.act('input', {
        sessionId: session.id,
        generation: session.generation,
        action: { type: 'scroll', x: 0, y: -250 },
      }),
    /Inspect this session first/,
  );
  assert.equal(get('interactive-session', f.owner, session.id).status, 'active');
  assert.equal(read(f.owner, f.taskId).commands.length, 0);
  assert.equal(
    f.act('input', {
      sessionId: session.id,
      generation: session.generation,
      action: { type: 'inspect' },
    }).status,
    'queued',
  );
  f.act('stop', { sessionId: session.id });
});

test('agent can stop its granted session but cannot stop a user takeover', () => {
  const f = fixture();
  let session = f.act('release', { sessionId: f.session.id, generation: f.session.generation });
  f.poll({ ready: [{ id: session.id, generation: session.generation }] });
  const args = {
    action: 'stop',
    sessionId: session.id,
    generation: session.generation,
    operationId: id(),
  };
  const stopped = tool(f.scope, args);
  assert.equal(stopped.status, 'stopped');
  assert.equal(tool(f.scope, args).status, 'stopped');
  const g = fixture();
  assert.throws(
    () =>
      tool(g.scope, {
        ...args,
        sessionId: g.session.id,
        generation: g.session.generation,
        operationId: id(),
      }),
    /agent-owned/,
  );
});

test('approval cannot grant access after the requesting run stops or finishes', () => {
  for (const patch of [{ stopRequested: true }, { status: 'succeeded' }, { status: 'unknown' }]) {
    const f = fixture();
    const request = tool(f.scope, {
      action: 'request',
      workerId: 'local',
      targetId: 'managed-browser',
      operationId: id(),
    });
    save('run', f.owner, { ...get('run', f.owner, f.scope.runId), ...patch });
    assert.throws(
      () => f.act('approve', { requestId: request.id }),
      /run has ended or was stopped/,
    );
    assert.equal(
      read(f.owner, f.taskId).requests.find((r: any) => r.id === request.id).status,
      'cancelled',
    );
    assert.equal(read(f.owner, f.taskId).sessions.length, 1);
  }
});

test('projects can always allow the task browser; requests then open without asking', () => {
  const f = fixture();
  const projectId = id();
  save('project', f.owner, { id: projectId, name: 'Tally', autoApproveTaskBrowser: true });
  save('task', f.owner, { ...get('task', f.owner, f.taskId), projectId });
  const result = tool(f.scope, {
    action: 'request',
    workerId: 'local',
    targetId: 'managed-browser',
    operationId: id(),
  });
  assert.equal(result.status, 'approved');
  assert.equal(result.autoApproved, true);
  assert.ok(result.sessionId);
  assert.equal(pending(f.owner).has(f.taskId), false);
  const session = read(f.owner, f.taskId).sessions.find((s: any) => s.id === result.sessionId);
  assert.equal(session.controlOwner, 'agent');
});

test('without the project setting, the task browser still asks', () => {
  const f = fixture();
  const projectId = id();
  save('project', f.owner, { id: projectId, name: 'Tally' });
  save('task', f.owner, { ...get('task', f.owner, f.taskId), projectId });
  const result = tool(f.scope, {
    action: 'request',
    workerId: 'local',
    targetId: 'managed-browser',
    operationId: id(),
  });
  assert.equal(result.status, 'pending');
  assert.equal(pending(f.owner).has(f.taskId), true);
});
