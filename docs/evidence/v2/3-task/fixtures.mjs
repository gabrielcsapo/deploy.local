// Board data only. Never imported by production code.
export const boards = [
  'Task',
  'TaskChanges',
  'TaskChecks',
  'Review',
  'PullRequests',
  'FirstTask',
  'TaskStalled',
  'TaskFailed',
  'NewProduct',
  'LongChat',
  'ShipDialog',
];
const at = '2026-10-27T18:41:00.000Z';
const you = (id, text) => ({ kind: 'you', id, at, text, attachments: [] });
const reply = (id, ...paragraphs) => ({ kind: 'reply', id, at, agent: 'scout', paragraphs });
const work = (id, summary, steps, live = false) => ({
  kind: 'worklog',
  id,
  at,
  summary,
  live,
  steps: steps.map((text) => ({ icon: 'terminal', text })),
});
const decision = (id) => ({ kind: 'decision', id, at, inboxItemId: id });
export const decisions = [
  {
    id: 'keep',
    title: 'How many releases should SER keep?',
    text: 'Each release is about 410 MB. Five use about 2 GB and cover a week of daily releases.',
    actions: [
      { id: 'five', label: 'Keep 5', primary: true },
      { id: 'three', label: 'Keep 3' },
      { id: 'answer', label: 'Answer in chat' },
    ],
  },
  {
    id: 'merge',
    kind: 'merge',
    title: 'Merge and release PR #18?',
    text: 'Releases to SER with prepare, verify and activate. Warden watches for 10 minutes and rolls back on failure.',
    actions: [
      { id: 'merge', label: 'Merge and release', primary: true },
      { id: 'changes', label: 'Request changes' },
      { id: 'later', label: 'Not now' },
    ],
  },
  {
    id: 'move',
    title: 'Move this task to MacBook Pro?',
    text: 'It continues from checkpoint 3 with the same model. If bazzite comes back, its copy is set aside, not merged.',
    actions: [
      { id: 'move', label: 'Move to MacBook Pro', primary: true },
      { id: 'wait', label: 'Wait for bazzite' },
      { id: 'stop', label: 'Stop task' },
    ],
  },
  {
    id: 'failed',
    title: 'What next?',
    text: 'The real fix is to record digests at install time. That changes preflight.ts, which Warden reviews.',
    actions: [
      { id: 'try', label: 'Try that with Opus', primary: true },
      { id: 'issue', label: 'Make an issue' },
      { id: 'stop', label: 'Stop' },
    ],
  },
].map((item) => ({
  kind: 'question',
  from: 'scout',
  state: 'waiting',
  createdAt: at,
  taskId: 'Task',
  ...item,
}));
export const pulls = [
  {
    id: '18',
    number: 18,
    title: 'Stop the repositories cancellation test timing out',
    status: 'open',
    revision: 0,
    sourceBranch: 'scout/cancel-timeout',
    targetBranch: 'main',
    taskIds: ['Review'],
  },
  {
    id: '19',
    number: 19,
    title: 'Show checks on merged pull requests',
    status: 'open',
    revision: 0,
    sourceBranch: 'scout/show-checks',
    targetBranch: 'main',
    taskIds: ['TaskChecks'],
  },
  {
    id: '17',
    number: 17,
    title: 'Keep leading zeros in SSH keys',
    status: 'merged',
    revision: 0,
    sourceBranch: 'scout/ssh-keys',
    targetBranch: 'main',
    taskIds: ['Review'],
  },
  {
    id: '16',
    number: 16,
    title: 'Run checks on the published version',
    status: 'merged',
    revision: 0,
    sourceBranch: 'scout/published-checks',
    targetBranch: 'main',
    taskIds: ['TaskChecks'],
  },
];
export const checks = [
  {
    id: 'unit',
    name: 'Unit tests',
    command: 'node --test server/release',
    status: 'succeeded',
    output:
      '✔ prepare builds into releases/<sha>       812ms\n✔ verify waits for /healthz before switching 1204ms\n✔ activate keeps earlier releases           96ms\n✔ rollback is unavailable without an earlier one 12ms\nℹ tests 18 · pass 18 · fail 0 · 4.1 s',
  },
  {
    id: 'type',
    name: 'Type check',
    command: 'pnpm typecheck',
    status: 'succeeded',
    output: 'Passed · 22 s',
  },
  {
    id: 'dry',
    name: 'Release dry run on SER',
    command: 'deploy-update prepare --dry-run',
    status: 'running',
    output: 'Running · 40 s',
  },
];
export const patch = `diff --git a/server/release/rollback.ts b/server/release/rollback.ts
--- a/server/release/rollback.ts
+++ b/server/release/rollback.ts
@@ -18,6 +18,9 @@ export async function rollback(options) {
   const releases = await listReleases(options.root);
-  const previous = releases.at(-2);
-  if (!previous) throw new Error('No previous release');
+  const current = await readCurrent(options.root);
+  const previous = releases.filter((r) => r.id !== current.id).at(-1);
+  if (!previous) return { status: 'unavailable' };
   await switchCurrent(options.root, previous.id);
+  const healthy = await waitForHealth(options.url, { timeoutMs: 30_000 });
+  if (!healthy) await switchCurrent(options.root, current.id);
   return { status: 'rolled-back', release: previous.id };
diff --git a/scripts/release.mjs b/scripts/release.mjs
new file mode 100644
--- /dev/null
+++ b/scripts/release.mjs
@@ -0,0 +1,4 @@
+#!/usr/bin/env node
+import { prepare, verify, activate } from '../server/release/index.js';
+
+const [command, ...args] = process.argv.slice(2);
`;
export function fixture(board) {
  const view = {
    task: {
      id: board,
      title: 'Self-release pipeline',
      projectId: 'deploy.local',
      status: 'running',
      revision: 0,
      sourceRef: 'main',
      createdAt: at,
    },
    project: {
      id: 'deploy.local',
      name: 'deploy.local',
      repository: 'deploy.local/deploy.local.git',
    },
    computer: 'MacBook Pro',
    run: { adapter: 'claude', model: 'Opus', status: 'running' },
    events: [
      you(
        'y',
        'Add prepare → verify → activate with rollback for SER releases. Keep deploy-update working. Ask before activating.',
      ),
      work('w', 'Worked for 9m', [
        'Read scripts/deploy-update.mjs and server/release/activate.ts',
        'Searched for releases/ in server · 9 results',
        'Edited 4 files · +178 −9',
        'Ran node --test server/release · 18 passed',
      ]),
      reply(
        'r',
        'Prepare and verify pass on SER: the new release builds in releases/c41d9e2, and the health check answers before the switch. Rollback keeps earlier releases on disk.',
      ),
      decision('keep'),
    ],
    cursor: 1,
    firstTask: false,
    pulls: [],
    checks,
    screenshots: [],
    releases: [],
    ship: { ref: 'main' },
  };
  if (board === 'FirstTask') {
    view.task.title = 'Add a shopping list to pantry';
    view.project.name = 'pantry';
    view.firstTask = true;
    view.events = [
      you('y', 'Add a shopping list to pantry that pulls in items about to expire.'),
      work(
        'w',
        'Reading the pantry code',
        ['Read src/items.ts and src/routes.ts', 'Searched for expiry · 4 results'],
        true,
      ),
    ];
  }
  if (board === 'Review') {
    view.task.title = pulls[0].title;
    view.pulls = [pulls[0]];
    view.run.status = 'succeeded';
    view.events = [
      reply(
        'r',
        'The cancellation test raced the clone finishing. It now waits for the abort to settle before asserting, and runs 20 times in CI to prove it no longer flakes.',
      ),
      reply(
        'review',
        'One issue: waitForAbort can hang if the clone already finished. Add a timeout.',
      ),
      work('w', 'Scout fixed it in 2m', [
        'Added a 5 s timeout to waitForAbort',
        'Ran the repositories suite 20 times · 20 passed',
      ]),
      decision('merge'),
    ];
  }
  if (board === 'TaskStalled') {
    view.task.title = 'Fix the sync migration';
    view.project.name = 'home-gym';
    view.computer = 'bazzite';
    view.run.status = 'unknown';
    view.events = [
      you(
        'y',
        'Fix forward: make the sync worker read started_at, add a test that runs the worker against the migrated schema, and open a PR.',
      ),
      work('w', 'Worked for 7m · checkpoint 3 saved', [
        'Read src/sync/workouts.ts and migration 0042',
        'Edited 2 files · +24 −6',
        'Started pnpm test src/sync · interrupted',
      ]),
      decision('move'),
    ];
  }
  if (board === 'TaskFailed') {
    view.task.title = 'Cache Discover images on SER';
    view.run.status = 'failed';
    view.events = [
      you('y', "Cache Discover images on SER so installs don't pull from the internet every time."),
      work('w', 'Worked for 22m', [
        'Read server/catalog/preflight.ts and service.ts',
        'Added a local image cache · +96 −4',
        'Ran pnpm test server/catalog · 3 failed',
        'Tried a content-addressed cache instead',
        'Ran pnpm test server/catalog · 3 failed',
      ]),
      reply(
        'r',
        "I couldn't get this working. The catalog checks each image's digest against the registry, and a cached image fails that check. I stopped after two approaches instead of loosening the check.",
        'My changes are saved on scout/discover-cache. There is no pull request.',
      ),
      decision('failed'),
    ];
  }
  if (['NewProduct', 'ShipDialog'].includes(board)) {
    view.task.title = 'Meal planner';
    view.project = {
      id: 'meal-planner',
      name: 'meal-planner',
      repository: 'deploy.local/meal-planner.git',
    };
    view.task.projectId = 'meal-planner';
    view.run.status = 'succeeded';
    view.ship = {
      ref: 'main',
      runsOn: 'SER',
      address: 'meal-planner.deploy.local',
      access: 'Everyone at home',
      data: 'A new Postgres on SER, backed up nightly',
    };
    view.events = [
      you(
        'y',
        'Build a small meal-planning app for my family: recipes, a plan for the week, and a shopping list from the plan.',
      ),
      work('w', 'Worked for 18m', [
        'Created the meal-planner project and repository',
        'Wrote 14 files · +612',
        'Ran tests and a build · 3 passed',
      ]),
      reply(
        'r',
        'The first version works: recipes, a week view you can drag meals into, and a shopping list that merges ingredients.',
      ),
      you('y2', 'Show me what it looks like on a phone and on a laptop.'),
      work('w2', 'Worked for 40s', [
        'Opened it in Safari on MacBook Pro',
        'Took 3 screenshots · 390 and 1440 wide',
      ]),
      ...['iPhone size', 'Shopping list', 'Laptop · 1440 wide'].map((device, i) => ({
        kind: 'screenshot',
        id: `s${i}`,
        at,
        screenshotId: `shot${i}`,
      })),
    ];
    view.screenshots = ['iPhone size', 'Shopping list', 'Laptop · 1440 wide'].map((device, i) => ({
      id: `shot${i}`,
      taskId: board,
      target: { kind: 'web', device },
      takenAt: at,
      image: `/api/fixture/screenshot/${i}.svg`,
    }));
  }
  if (board === 'LongChat') {
    view.task.title = 'Scout';
    view.run.model = 'Qwen3-8B · local';
    view.events = [
      {
        ...reply('week', '5 briefs · 9 tasks started, 7 shipped, 2 closed'),
        at: '2026-10-20T12:00:00Z',
      },
      { ...reply('monday', 'Morning brief · 2 proposals, both done'), at: '2026-10-25T12:00:00Z' },
      {
        ...reply('yesterday', 'Brief and 3 follow-ups · started Self-release pipeline'),
        at: '2026-10-26T12:00:00Z',
      },
      work('w', 'Worked for 1m', [
        "Reviewed 14 pull requests and last week's tasks",
        'Checked SER 2a91c0e with Warden · healthy',
      ]),
      reply('r', 'PR #17 shipped overnight. PR #18 is ready for you.'),
      decision('merge'),
    ];
  }
  return view;
}
