import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { computerRoles } from '../computer-roles.ts';

process.env.DEPLOY_DATA_DIR = mkdtempSync(join(tmpdir(), 'deploy-context-'));
const { assembleAgentContext, operatingManual } = await import('./agent-context.ts');
const { agentLaunch } = await import('./agent-launch.ts');
const { coordinationTools } = await import('./coordination-tools.ts');
const { get, save, now } = await import('./store.ts');
const { workerCommand } = await import('./protocol.ts');
const { createTask } = await import('./test-repository.ts');
const { startRun } = await import('./service.ts');
const { workspaceApi } = await import('./api.ts');

const workers = [
  {
    id: 'local',
    name: 'SER',
    platform: 'linux',
    architecture: 'x64',
    status: 'online',
    capabilities: ['node', 'python', 'codex'],
  },
  {
    id: 'mac',
    name: 'MacBook',
    platform: 'darwin',
    architecture: 'arm64',
    status: 'offline',
    capabilities: ['xcode', 'swift', 'node'],
    token: 'never-include-this',
  },
];
const fixture = {
  task: { id: 'task', title: 'Build the app' },
  project: null,
  workerId: 'local',
  computers: computerRoles([], workers),
  workers,
  origins: [],
  deployments: [],
  coordinatorUrl: 'https://username:secret@deploy.local/private?token=hidden',
};
test('context uses roles and reported capabilities, preserves offline state and stays short', () => {
  const text = assembleAgentContext(fixture);
  assert.match(
    text,
    /Project: no project — create one with deploy_create_repository before shipping/,
  );
  const situation = text.split('Situation (snapshot')[1];
  assert.match(situation, /This run: worker "local"; "SER"; linux\/x64; online/);
  assert.match(
    situation,
    /"MacBook"; darwin\/arm64; offline; roles:.*tasks=needs-setup.*capabilities: xcode, swift, node/,
  );
  assert.match(situation, /Coordinator: https:\/\/deploy.local; the local CA is trusted/);
  assert.doesNotMatch(text, /never-include-this|username|secret@|private\?token/);
  assert.ok(situation.split('\n').length < 40);
  for (const tool of coordinationTools) assert.ok(operatingManual.includes(`${tool.name}:`));
  // Agents are told how to run verification so its result records exactly.
  assert.match(operatingManual, /run them without piping when you can/);
  assert.match(operatingManual, /set -o pipefail/);
  assert.match(operatingManual, /Result unknown \(output piped\)/);
});
test('project and deployed app records are scoped to this task and do not invent successful status', () => {
  const text = assembleAgentContext({
    ...fixture,
    project: { name: 'Tally' },
    origins: [
      {
        id: 'tally',
        app: 'tally',
        taskId: 'task',
        status: 'building',
        env: { SECRET: 'hidden-env' },
      },
    ],
    deployments: [
      {
        taskId: 'task',
        application: 'tally',
        result: { status: 'running', url: 'https://tally.local' },
      },
      {
        taskId: 'task',
        application: 'notes',
        result: { status: 'failed', url: 'https://notes.local' },
      },
      { taskId: 'someone-else', application: 'other-app', result: { status: 'running' } },
    ],
  });
  const situation = text.split('Situation (snapshot')[1];
  assert.match(situation, /Project: "Tally"/);
  assert.match(situation, /"tally"; https:\/\/tally.local; last recorded status="building"/);
  assert.match(situation, /"notes"; https:\/\/notes.local; last recorded status="failed"/);
  assert.equal(situation.match(/Task application: "tally"/g)?.length, 1);
  assert.doesNotMatch(situation, /other-app|hidden-env/);
});
test('latest completed deployment supersedes an older origin status without claiming verification', () => {
  const text = assembleAgentContext({
    ...fixture,
    origins: [{ id: 'app', taskId: 'task', status: 'building', updatedAt: '2026-10-20T00:00:00Z' }],
    deployments: [
      {
        taskId: 'task',
        application: 'app',
        completedAt: '2026-10-21T00:00:00Z',
        result: { status: 'failed', url: 'https://app.local' },
      },
    ],
  }).split('Situation (snapshot')[1];
  assert.match(text, /last recorded status="failed"/);
  assert.doesNotMatch(text, /building|passed|verified/);
});
test('large inventories remain under forty situation lines and acknowledge omitted records', () => {
  const text = assembleAgentContext({
    ...fixture,
    computers: Array.from({ length: 80 }, (_, index) => ({
      ...fixture.computers[1],
      id: `mac-${index}`,
      workerIds: [`mac-${index}`],
    })),
    origins: Array.from({ length: 30 }, (_, index) => ({ id: `app-${index}`, taskId: 'task' })),
  });
  const situation = text.split('Situation (snapshot')[1];
  assert.ok(situation.split('\n').length < 40);
  assert.match(situation, /56 more computers/);
  assert.match(situation, /23 more task applications/);
});
test('provider launch selects a system path and Codex receives exact escaped inline instructions on resume', () => {
  const agentContext = 'Manual\n"Situation"\\path';
  const codex = agentLaunch({ adapter: 'codex', agentContext, sessionId: 'resume-id' });
  assert.ok(codex.args.includes(`developer_instructions=${JSON.stringify(agentContext)}`));
  assert.ok(codex.args.includes('resume'));
  assert.equal(codex.instructionDelivery, 'codex-developer-instructions');
  for (const adapter of ['claude', 'compatible']) {
    const launch = agentLaunch({ adapter, agentContext });
    assert.ok('DEPLOY_AGENT_INSTRUCTIONS' in launch.env);
    assert.equal(launch.env.DEPLOY_AGENT_INSTRUCTIONS, agentContext);
    assert.match(
      launch.instructionDelivery,
      /claude-append-system-prompt|compatible-system-message/,
    );
  }
});
test('remote assignment captures the live owner snapshot once and exposes the exact text through the task API', async () => {
  const owner = 'context-owner';
  workerCommand(owner, '/workers/register', {
    workerId: 'mac',
    name: 'MacBook',
    platform: 'darwin',
    architecture: 'arm64',
    capabilities: ['xcode', 'swift'],
    codex: true,
  });
  const task = createTask(owner, { title: 'Live assignment', workerId: 'mac' });
  const run = startRun(owner, task.id, { revision: task.revision, content: 'My exact words' });
  assert.equal(get('run', owner, run.id).agentContext, undefined);
  save('application-origin', owner, {
    id: 'just-deployed',
    app: 'just-deployed',
    taskId: task.id,
    status: 'running',
  });
  save('application-origin', 'someone-else', {
    id: 'private-app',
    app: 'private-app',
    taskId: task.id,
    status: 'running',
  });
  const assignment = workerCommand(owner, '/workers/mac/poll', {});
  assert.equal(assignment.run.prompt, 'My exact words');
  assert.match(assignment.run.agentContext, /just-deployed/);
  assert.doesNotMatch(assignment.run.agentContext, /private-app/);
  assert.equal(assignment.run.agentContext, get('run', owner, run.id).agentContext);
  assert.ok(Date.parse(assignment.run.agentContextAt) <= Date.parse(now()));
  save('worker', owner, { ...get('worker', owner, 'mac'), name: 'Changed after assignment' });
  assert.equal(
    workerCommand(owner, '/workers/mac/poll', {}).run.agentContext,
    assignment.run.agentContext,
  );
  let status = 0;
  let body = '';
  await workspaceApi(
    Object.assign(Readable.from([]), {
      method: 'GET',
      url: `/api/workspace/tasks/${task.id}`,
      headers: {},
    }) as IncomingMessage,
    {
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        body = value;
      },
    } as ServerResponse,
    owner,
  );
  assert.equal(status, 200);
  const detail = JSON.parse(body);
  assert.equal(detail.runs[0].agentContext, assignment.run.agentContext);
  assert.equal(detail.runs[0].agentContextAt, assignment.run.agentContextAt);
});

test('coordinator snapshot warns about missing tools and survives remote launch for every adapter', () => {
  const missing = ['deploy_commit', 'deploy_application'];
  const remote = {
    ...workers[1],
    build: { version: '1.0.0' },
    agentTools: coordinationTools.map((t) => t.name).filter((name) => !missing.includes(name)),
  };
  const text = assembleAgentContext({ ...fixture, workerId: remote.id, workers: [remote] });
  assert.match(
    text,
    /Worker update needed: this worker lacks deploy_commit, deploy_application\. Ask the user via deploy_ask_user/,
  );
  const legacy = assembleAgentContext({ ...fixture, workerId: 'mac' });
  assert.match(legacy, /Worker update needed: newer agent tools may be unavailable/);
  assert.doesNotMatch(assembleAgentContext(fixture), /Worker update needed:/);
  for (const adapter of ['codex', 'claude', 'compatible']) {
    const launch = agentLaunch({ adapter, agentContext: text });
    if (adapter === 'codex')
      assert.ok(launch.args.includes(`developer_instructions=${JSON.stringify(text)}`));
    else {
      assert.ok('DEPLOY_AGENT_INSTRUCTIONS' in launch.env);
      assert.equal(launch.env.DEPLOY_AGENT_INSTRUCTIONS, text);
    }
  }
});

test('next run prompt includes visible shell results once, excludes hidden cards even on adapter handoff', () => {
  const owner = 'shell-context-owner';
  workerCommand(owner, '/workers/register', {
    workerId: 'shell-mac',
    name: 'Mac',
    platform: 'darwin',
    capabilities: ['swift'],
    codex: true,
  });
  const task = createTask(owner, { title: 'Command context', workerId: 'shell-mac' });
  for (const hidden of [false, true])
    save('message', owner, {
      id: hidden ? 'hidden-command' : 'visible-command',
      taskId: task.id,
      role: 'user',
      content: hidden ? 'SECRET OUTPUT' : 'pwd',
      createdAt: now(),
      shell: {
        command: hidden ? 'hidden command' : 'pwd',
        computer: 'Mac',
        output: hidden ? 'SECRET OUTPUT' : '/tasks/context',
        code: 0,
        status: 'ended',
        version: 1,
        hidden,
      },
    });
  const first = startRun(owner, task.id, {
    revision: task.revision,
    content: 'Explain the results',
  });
  assert.match(first.prompt, /\/tasks\/context/);
  assert.doesNotMatch(first.prompt, /SECRET|hidden command/);
  save('run', owner, {
    ...get('run', owner, first.id),
    status: 'completed',
    adapter: 'claude',
    sessionId: 'old-session',
  });
  const second = startRun(owner, task.id, {
    revision: get('task', owner, task.id).revision,
    content: 'Continue',
  });
  assert.doesNotMatch(second.prompt, /SECRET|hidden command|\/tasks\/context/);
  save('run', owner, { ...get('run', owner, second.id), status: 'completed' });
  const hidden = get('message', owner, 'hidden-command');
  save('message', owner, { ...hidden, shell: { ...hidden.shell, hidden: false } });
  const third = startRun(owner, task.id, {
    revision: get('task', owner, task.id).revision,
    content: 'Now include the command',
  });
  assert.match(third.prompt, /SECRET OUTPUT/);
});
