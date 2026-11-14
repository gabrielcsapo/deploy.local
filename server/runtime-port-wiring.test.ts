import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'deploy-runtime-ports-'));
process.env.DEPLOY_DATA_DIR = directory;
after(() => rmSync(directory, { recursive: true, force: true }));
const refresh = await import('./v2/state-refresh-sources-port.ts');
const runs = await import('./workspace/task-run-starter-port.ts');
const chat = await import('./v2/agent-chat-source-port.ts');
const answers = await import('./workspace/question-answer-resumer-port.ts');
for (const [name, require] of [
  ['StateRefreshSources', refresh.requireStateRefreshSources],
  ['TaskRunStarter', runs.requireTaskRunStarter],
  ['AgentChatSource', chat.requireAgentChatSource],
  ['QuestionAnswerResumer', answers.requireQuestionAnswerResumer],
] as const)
  test(`unwired ${name} names its port and process`, () => {
    assert.throws(() => require('test process'), {
      message: `${name} is not wired in test process`,
    });
  });

test('runtime ports expose the original provider functions', async () => {
  await import('./test-ports.ts');
  const service = await import('./workspace/service.ts');
  const questions = await import('./workspace/questions.ts');
  const agents = await import('./v2/agents.ts');
  const live = await import('./v2/live.ts');
  const inbox = await import('./v2/inbox.ts');
  assert.equal(runs.requireTaskRunStarter('test'), service.startRun);
  assert.equal(answers.requireQuestionAnswerResumer('test'), questions.resumeQuestionAnswers);
  const sources = await refresh.requireStateRefreshSources('test')();
  assert.equal(sources.getLive, live.getLive);
  assert.equal(sources.syncInbox, inbox.syncInbox);
  const agent = await chat.requireAgentChatSource('test')();
  for (const name of [
    'agentsForOwner',
    'agentConversation',
    'agentTeachingPrompt',
    'saveAgentReply',
  ] as const)
    assert.equal(agent[name], agents[name]);
});

function child(code: string) {
  const data = mkdtempSync(join(tmpdir(), 'deploy-runtime-port-child-'));
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: process.cwd(),
      env: { ...process.env, DEPLOY_DATA_DIR: data, DEPLOY_MDNS_ADDRESS: '127.0.0.1' },
      encoding: 'utf8',
      timeout: 30000,
    });
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
}
const track = `
  import assert from 'node:assert/strict';
  import { registerHooks } from 'node:module';
  const loaded = new Set();
  registerHooks({ load(url, context, next) {
    const result = next(url, context); loaded.add(url); return result;
  }});
  const has = path => loaded.has(new URL(path, import.meta.url).href);
`;
for (const [composition, port, require, modules] of [
  [
    'state-refresh-sources',
    'v2/state-refresh-sources',
    'requireStateRefreshSources',
    ['live', 'inbox'],
  ],
  ['agent-chat-source', 'v2/agent-chat-source', 'requireAgentChatSource', ['agents']],
] as const)
  test(`${composition} loads its providers on first call, never during wiring`, () => {
    child(`${track}
      const composition = await import('./server/main/${composition}.ts');
      Object.values(composition)[0]();
      const { ${require}: get } = await import('./server/${port}-port.ts');
      for (const name of ${JSON.stringify(modules)}) assert.equal(has('./server/v2/' + name + '.ts'), false);
      await get('child')();
      for (const name of ${JSON.stringify(modules)}) assert.equal(has('./server/v2/' + name + '.ts'), true);
    `);
  });

const entries = [
  [
    'server/boot.ts',
    '/** Serves the pages',
    'wireTaskRunStarter(); wireQuestionAnswerResumer(); wireStateRefreshSources(); wireAgentChatSource();',
    [true, true, true, true],
  ],
  [
    'server/workspace/repository-worker.ts',
    '// Git storage service only.',
    '',
    [false, false, false, false],
  ],
  [
    'server/workspace/pipeline-worker.ts',
    "claimWorker('pipelines');",
    '',
    [false, false, false, false],
  ],
  [
    'server/workspace/worker.ts',
    'wireLocalWorkerTaskRuns();',
    'wireLocalWorkerTaskRuns();',
    [true, true, false, false],
  ],
  [
    'server/workspace/preview.ts',
    'wireTaskRunStarter();',
    'wireTaskRunStarter(); wireQuestionAnswerResumer();',
    [true, true, false, false],
  ],
] as const;
for (const [entry, marker, wire, expected] of entries)
  test(`${entry} registers exactly its callable ports in a fresh process`, () => {
    child(`${track}
      registerHooks({ load(url, context, next) {
        const result = next(url, context);
        if (url === new URL('./${entry}', import.meta.url).href) {
          const source = String(result.source);
          const end = source.indexOf(${JSON.stringify(marker)});
          assert.ok(end >= 0);
          return { ...result, source: source.slice(0, end) + ${JSON.stringify(wire)} };
        }
        return result;
      }});
      await import('./${entry}');
      const getters = [
        (await import('./server/workspace/task-run-starter-port.ts')).requireTaskRunStarter,
        (await import('./server/workspace/question-answer-resumer-port.ts')).requireQuestionAnswerResumer,
        (await import('./server/v2/state-refresh-sources-port.ts')).requireStateRefreshSources,
        (await import('./server/v2/agent-chat-source-port.ts')).requireAgentChatSource,
      ];
      getters.forEach((get, i) => {
        if (${JSON.stringify(expected)}[i]) assert.equal(typeof get('child'), 'function');
        else assert.throws(() => get('child'), /is not wired in child/);
      });
    `);
  });
