import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import type {
  ConversationEvent,
  InboxItem,
  Release,
  Rollback,
  AppHealth,
  Role,
  ApprovalAction,
  ApprovalRule,
  Agent,
  Screenshot,
  Markup,
  Attachment,
} from '../../shared/v2/contracts.ts';

const attachment: Attachment = {
  kind: 'project-file',
  name: 'main.ts',
  bytes: 42,
  ref: 'file:main.ts',
};
const markup: Markup = {
  strokes: [
    {
      tool: 'arrow',
      color: 0,
      points: [
        [1, 2],
        [3.5, 4],
      ],
    },
  ],
  texts: [{ x: 1, y: 2, text: 'Here', color: 2 }],
};
const conversation: ConversationEvent[] = [
  {
    kind: 'you',
    id: '1',
    at: '2026-10-27T14:00:00Z',
    text: 'Hello',
    attachments: [attachment],
    model: 'local',
  },
  {
    kind: 'reply',
    id: '2',
    at: 'now',
    agent: 'scout',
    paragraphs: ['Done'],
    receipts: [{ kind: 'job' }, { kind: 'looks-after', itemId: 'weekly' }],
  },
  {
    kind: 'worklog',
    id: '3',
    at: 'now',
    summary: 'Edited a file',
    steps: [{ icon: 'edit', text: 'main.ts', added: 2, removed: 1 }],
    live: false,
  },
  { kind: 'decision', id: '4', at: 'now', inboxItemId: 'question:q' },
  { kind: 'task', id: '5', at: 'now', taskId: 'task' },
  { kind: 'release', id: '6', at: 'now', releaseId: '9c3e1fa' },
  { kind: 'screenshot', id: '7', at: 'now', screenshotId: 'image' },
  {
    kind: 'report',
    id: '8',
    at: 'now',
    title: 'Report',
    sections: [{ title: 'Result', body: 'Done' }],
  },
];
const inbox: InboxItem = {
  id: 'question:q',
  kind: 'question',
  title: 'Which?',
  text: 'Choose',
  from: 'scout',
  projectId: 'home-gym',
  taskId: 'task',
  createdAt: 'now',
  actions: [{ id: 'answer', label: 'Answer', primary: true, confirm: 'Confirm?' }],
  state: 'answered',
  outcome: { text: 'Healthy after 10 min', tone: 'ok' },
  answer: { actionId: 'answer', by: 'owner', on: 'iphone', at: 'now', note: 'Blue' },
};
const release: Release = {
  id: '9c3e1fa',
  projectId: 'home-gym',
  source: { kind: 'ship', ref: 'main' },
  startedBy: 'owner',
  apps: [{ appId: 'web', from: 'old', to: 'new' }],
  migrations: [{ id: '42', title: 'Add column', reversible: true }],
  backupId: 'backup',
  steps: [{ name: 'prepare', state: 'done', startedAt: 'then', endedAt: 'now', detail: 'Ready' }],
  state: 'live',
};
const rollback: Rollback = {
  id: 'back',
  projectId: 'home-gym',
  from: 'new',
  to: 'old',
  reason: 'Failing',
  approvedBy: 'rule',
  ruleId: 'rule',
  steps: release.steps,
};
const health: AppHealth = {
  appId: 'web',
  kind: 'web',
  state: 'healthy',
  summary: 'Healthy',
  http: { path: '/', status: 200, p95ms: 4, reqPerMin: 2 },
  jobs: { perMin: 3, failRate: 0.1, baselineFailRate: 0 },
  queue: { depth: 1, oldestSec: 3 },
  restarts: { count: 1, windowSec: 60 },
  heartbeatAt: 'now',
};
const role: Role = 'use-screen';
const action: ApprovalAction = 'change-secrets';
const rule: ApprovalRule = {
  id: 'rule',
  agent: 'warden',
  action: 'rollback',
  projectId: 'home-gym',
  mode: 'ask',
  limit: 'one',
};
const agent: Agent = {
  id: 'scout',
  name: 'Scout',
  job: 'Take tasks',
  computers: ['SER'],
  createdBy: 'owner',
};
const screenshot: Screenshot = {
  id: 'image',
  taskId: 'task',
  target: { kind: 'ios-simulator', device: 'iPhone', url: 'https://example.invalid' },
  takenAt: 'now',
  image: 'image:1',
  markup,
};
const fixture = {
  conversation,
  inbox,
  release,
  rollback,
  health,
  role,
  action,
  rule,
  agent,
  screenshot,
  markup,
  attachment,
};

test('contracts resolve in Node, Vite, and the existing CLI bundler without aliases', async () => {
  assert.deepEqual(Object.keys(await import('../../shared/v2/contracts.ts')), []);
  const { build } = createRequire(import.meta.resolve('vite'))('esbuild');
  const result = await build({
    stdin: {
      contents: "import * as contracts from './shared/v2/contracts.ts'; console.log(contracts);",
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  });
  assert.equal(result.errors.length, 0);
  const vite = await import('vite');
  await vite.build({
    configFile: false,
    logLevel: 'silent',
    build: { write: false, lib: { entry: resolve('shared/v2/contracts.ts'), formats: ['es'] } },
  });
});

test('Swift Codable round-trips every contract and flat conversation variant', (t) => {
  if (spawnSync('swiftc', ['--version']).error) return t.skip('Swift compiler unavailable');
  const dir = mkdtempSync(join(tmpdir(), 'deploy-v2-contracts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fields = {
    conversation: '[ConversationEvent]',
    inbox: 'InboxItem',
    release: 'Release',
    rollback: 'Rollback',
    health: 'AppHealth',
    role: 'Role',
    action: 'ApprovalAction',
    rule: 'ApprovalRule',
    agent: 'Agent',
    screenshot: 'Screenshot',
    markup: 'Markup',
    attachment: 'Attachment',
  };
  writeFileSync(
    join(dir, 'main.swift'),
    `import Foundation
struct Fixture: Codable {\n${Object.entries(fields)
      .map(([name, type]) => `let ${name}: ${type}`)
      .join('\n')}\n}
let input = FileHandle.standardInput.readDataToEndOfFile()
let value = try JSONDecoder().decode(Fixture.self, from: input)
FileHandle.standardOutput.write(try JSONEncoder().encode(value))
`,
  );
  const compiled = spawnSync(
    'swiftc',
    [
      '-module-cache-path',
      join(dir, 'cache'),
      resolve('native/Apple/Packages/DeployKit/Sources/DeployCore/V2Contracts.swift'),
      join(dir, 'main.swift'),
      '-o',
      join(dir, 'roundtrip'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(compiled.status, 0, compiled.stderr);
  const result = spawnSync(join(dir, 'roundtrip'), [], {
    input: JSON.stringify(fixture),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), fixture);
});
