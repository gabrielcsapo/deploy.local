import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import {
  DESIGN_HELP,
  DESIGN_README,
  designSlug,
  projectFromRemote,
  reviewQuestions,
  runDesign,
  titleFromBranch,
} from './cli-design.mjs';

const git = (args, cwd, env) =>
  execFileSync('git', args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();

/** An origin with main, and a clone of it named deploy.local, both in a fresh folder. */
function repository({ design = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cli-design-')));
  const origin = join(root, 'origin.git');
  git(['init', '--bare', '--initial-branch=main', origin], root);
  const seed = join(root, 'seed');
  git(['init', '--initial-branch=main', seed], root);
  git(['config', 'user.name', 'Test'], seed);
  git(['config', 'user.email', 'test@example.invalid'], seed);
  if (design) {
    mkdirSync(join(seed, 'design/boards'), { recursive: true });
    writeFileSync(join(seed, 'design/boards/Sidebar.html'), '<p data-layer="name">Name</p>');
    writeFileSync(
      join(seed, 'design/canvas.json'),
      JSON.stringify({
        title: 'Site',
        boards: { 'Sidebar.html': { x: 0, y: 0, w: 1440, h: 900 } },
      }),
    );
  } else writeFileSync(join(seed, 'README.md'), '# catan\n');
  git(['add', '.'], seed);
  git(['commit', '-qm', 'Design'], seed);
  git(['remote', 'add', 'origin', origin], seed);
  git(['push', '-q', 'origin', 'main'], seed);
  const clone = join(root, 'deploy.local');
  git(['clone', '-q', origin, clone], root);
  git(['config', 'user.name', 'Test'], clone);
  git(['config', 'user.email', 'test@example.invalid'], clone);
  return { root, origin, clone, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A coordinator in memory: it answers the design routes and records every write. */
function coordinator(feedback = []) {
  const calls = [];
  let reads = 0;
  const api = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, method: options.method ?? 'GET', body });
    if (path.endsWith('/working')) return { working: { ...body, by: 'Gabriel' } };
    if (path.endsWith('/propose'))
      return { item: { id: 'design:site:design~sidebar-by-project:abc', title: body.title } };
    if (path.endsWith('/feedback/resolve'))
      return { comment: { id: 'c1', resolved: true, reply: body.reply } };
    if (path.includes('/feedback')) return feedback[Math.min(reads++, feedback.length - 1)];
    throw Object.assign(new Error('Not found'), { status: 404 });
  };
  return { api, calls };
}

/** A coordinator that also checks designs: each check is answered from the request's body. */
const checking =
  (api, answer) =>
  async (path, options = {}) =>
    path.endsWith('/check') ? answer(JSON.parse(options.body)) : api(path, options);

const NOW = Date.parse('2026-11-17T12:04:00Z');
function terminal(cwd, api, extra = {}) {
  let text = '';
  return {
    deps: {
      api,
      cwd,
      git,
      computer: 'MacBook Pro',
      serverUrl: 'https://deploy.local',
      home: '/nowhere',
      exists: existsSync,
      write: (chunk) => (text += chunk),
      color: false,
      spinner: false,
      interactive: false,
      prompt: async () => '',
      now: () => NOW,
      sleep: async () => {},
      ...extra,
    },
    text: () => text,
  };
}

const checked = (problems = []) => ({
  named: 4,
  drawn: 3,
  widths: [1440, 700],
  schemes: ['light', 'dark'],
  seconds: 12,
  boards: [
    {
      file: 'Sidebar.html',
      title: 'Sidebar',
      words: 'Tasks grouped under their project',
      problems: [],
    },
    {
      file: 'Projects.html',
      title: 'Projects',
      words: 'New Show menu',
      problems: problems.length ? ['cut off at 700 px'] : [],
    },
    {
      file: 'Project.html',
      title: 'Project',
      words: 'Breadcrumb back to Projects',
      problems: [],
    },
  ],
  problems,
  pairs: 'output/design/pairs',
});
const cutOff = [
  {
    file: 'Projects.html',
    label: 'Projects is cut off at 700 px',
    detail: '"Show archived" leaves the page',
    short: 'cut off at 700 px',
  },
];

test('names: the branch slug, the title back from a branch, the project from its origin', () => {
  assert.equal(designSlug('Sidebar by project!'), 'sidebar-by-project');
  assert.equal(titleFromBranch('design/sidebar-by-project'), 'Sidebar by project');
  assert.equal(projectFromRemote('https://deploy.local/api/git/p1/deploy.local.git'), 'p1');
  assert.equal(projectFromRemote('git@github.com:me/x.git'), null);
  // The short addresses name the repository, which the coordinator takes in place of the ID.
  assert.equal(projectFromRemote('ssh://git@deploy.local:2222/catan.git'), 'catan');
  assert.equal(projectFromRemote('ssh://git@deploy.local:2222/catan'), 'catan');
  assert.equal(projectFromRemote('git@deploy.local:catan.git'), 'catan');
  assert.equal(projectFromRemote('https://deploy.local/catan.git'), 'catan');
  assert.equal(projectFromRemote('https://deploy.local/dashboard'), null);
  assert.equal(projectFromRemote('ssh://git@github.com/me/x.git'), null);
  assert.equal(projectFromRemote('ssh://git@ser.lan:2222/catan.git'), null);
  assert.equal(
    projectFromRemote('ssh://git@ser.lan:2222/catan.git', 'https://ser.lan:8443'),
    'catan',
  );
});

test('start asks about the project first and leaves nothing behind when it is refused', async () => {
  const repo = repository();
  try {
    const folder = join(repo.root, 'deploy.local-sidebar-by-project');
    const left = () => [
      existsSync(folder),
      git(['branch', '--list', 'design/*'], repo.clone),
      git(['worktree', 'list', '--porcelain'], repo.clone).split('\n\n').length,
    ];
    // No such project: said before a branch or a folder is made.
    const missing = terminal(repo.clone, async () => {
      throw Object.assign(new Error('Not found'), { status: 404 });
    });
    await assert.rejects(
      () => runDesign('start', ['Sidebar by project'], { project: 'catan' }, missing.deps),
      (error) =>
        error.message === 'deploy.local has no project "catan".' &&
        error.exitCode === 1 &&
        missing.text() === '',
    );
    assert.deepEqual(left(), [false, '', 1]);
    // Refused after the branch was made: the branch and its folder go again.
    const refused = terminal(repo.clone, async (path) => {
      if (path.endsWith('/working')) throw Object.assign(new Error('Try again'), { status: 503 });
      return { review: null };
    });
    await assert.rejects(
      () => runDesign('start', ['Sidebar by project'], { project: 'site' }, refused.deps),
      /Try again/,
    );
    assert.deepEqual(left(), [false, '', 1]);
  } finally {
    repo.cleanup();
  }
});

test('start makes the branch from main in a folder of its own and says who has it', async () => {
  const repo = repository();
  try {
    const server = coordinator();
    const run = terminal(repo.clone, server.api);
    const result = await runDesign('start', ['Sidebar by project'], { project: 'site' }, run.deps);
    assert.equal(result.exitCode, 0);
    const commit = git(['rev-parse', '--short=7', 'origin/main'], repo.clone);
    assert.equal(
      run.text(),
      [
        '✓ Project                          site',
        `✓ Fetched main                     ${commit} · just now`,
        '✓ Branch                           design/sidebar-by-project',
        '✓ Folder                           ../deploy.local-sidebar-by-project',
        '',
        'Sidebar by project is yours on MacBook Pro.',
        'It shows on the Design page as being worked on.',
        '',
        'Edit the boards in design/boards. To see them as you save:',
        '  cd ../deploy.local-sidebar-by-project',
        '  deploy design dev',
        '',
      ].join('\n'),
    );
    const folder = join(repo.root, 'deploy.local-sidebar-by-project');
    assert.equal(git(['branch', '--show-current'], folder), 'design/sidebar-by-project');
    assert.deepEqual(server.calls, [
      {
        path: '/api/projects/site/design/feedback?branch=design%2Fsidebar-by-project',
        method: 'GET',
        body: undefined,
      },
      {
        path: '/api/projects/site/design/working',
        method: 'POST',
        body: { branch: 'design/sidebar-by-project', computer: 'MacBook Pro' },
      },
    ]);
    // The same title again: the branch exists, so nothing is made.
    await assert.rejects(
      () => runDesign('start', ['Sidebar by project'], { project: 'site' }, run.deps),
      (error) =>
        /design\/sidebar-by-project already exists/.test(error.message) && error.exitCode === 1,
    );
    mkdirSync(join(repo.root, 'deploy.local-taken'));
    await assert.rejects(
      () => runDesign('start', ['Taken'], { project: 'site' }, run.deps),
      /\.\.\/deploy.local-taken already exists/,
    );
    await assert.rejects(
      () => runDesign('start', [], { project: 'site' }, run.deps),
      (error) => error.exitCode === 2,
    );
  } finally {
    repo.cleanup();
  }
});

test('start in a project with no design writes its first one, and says when main here is ahead', async () => {
  const repo = repository({ design: false });
  try {
    // Two commits on main here that origin does not have.
    for (const text of ['one', 'two']) {
      writeFileSync(join(repo.clone, 'notes.txt'), text);
      git(['add', '.'], repo.clone);
      git(['commit', '-qm', text], repo.clone);
    }
    const server = coordinator([
      { branch: 'design/harbor-trade', owner: 'Gabriel', project: 'catan', review: null },
    ]);
    const run = terminal(repo.clone, server.api);
    const result = await runDesign('start', ['Harbor trade'], { project: 'p1' }, run.deps);
    assert.equal(result.exitCode, 0);
    const commit = git(['rev-parse', '--short=7', 'origin/main'], repo.clone);
    assert.equal(
      run.text(),
      [
        '✓ Project                          catan',
        `✓ Fetched main                     ${commit} · just now`,
        '! main here is 2 commits ahead     origin does not have them yet',
        '✓ Branch                           design/harbor-trade',
        '✓ Folder                           ../deploy.local-harbor-trade',
        '✓ First design                     canvas.json · boards/Board.html · README.md',
        '',
        'Harbor trade is yours on MacBook Pro.',
        'It shows on the Design page as being worked on.',
        '',
        'To draw from your newer main:',
        '  git push origin main',
        '  git -C ../deploy.local-harbor-trade merge origin/main',
        '',
        'This project had no design. How one is written:',
        '  design/README.md',
        '',
        'Edit the boards in design/boards. To see them as you save:',
        '  cd ../deploy.local-harbor-trade',
        '  deploy design dev',
        '',
      ].join('\n'),
    );
    const folder = join(repo.root, 'deploy.local-harbor-trade');
    // The branch starts from origin's main, not the newer main here.
    assert.equal(git(['rev-parse', 'HEAD'], folder), git(['rev-parse', 'origin/main'], folder));
    const canvas = JSON.parse(readFileSync(join(folder, 'design/canvas.json'), 'utf8'));
    assert.deepEqual(canvas, {
      title: 'catan',
      boards: { 'Board.html': { x: 0, y: 0, w: 1440, h: 900, title: 'Board' } },
      order: ['Board.html'],
      notes: {},
    });
    assert.equal(readFileSync(join(folder, 'design/README.md'), 'utf8'), DESIGN_README);
    const board = readFileSync(join(folder, 'design/boards/Board.html'), 'utf8');
    assert.match(board, /<meta name="design-board" content="width=1440,height=900">/);
    assert.match(board, /data-layer="title"/);
    assert.doesNotMatch(board, /<script|<img/);
    assert.deepEqual(result.json.firstDesign, ['canvas.json', 'boards/Board.html', 'README.md']);
    assert.equal(result.json.main.ahead, 2);
  } finally {
    repo.cleanup();
  }
});

test('the README start writes says how a canvas and a board are written, as the board shows', () => {
  assert.equal(
    DESIGN_README.split('\n').slice(0, 9).join('\n'),
    [
      '# Design',
      '',
      "This folder is the app's design: one board per screen, reviewed",
      "on deploy.local's Design page before anything is built.",
      '',
      '## canvas.json',
      '{ "title", "boards": { "<Name>.html": { "x", "y", "w", "h", "title" } },',
      '  "order": ["<Name>.html"], "notes": { "<id>": { "x", "y", "text" } } }',
      'Web boards are 1440 wide and are checked at 700 too. Phone boards',
    ].join('\n'),
  );
  assert.match(
    DESIGN_HELP,
    /^deploy design — change what people see, on the same branch as the code\n/,
  );
  assert.match(DESIGN_HELP, /\n {2}guide {20}How to work on this project's design\n/);
  assert.match(DESIGN_HELP, /\n {2}status \[<Board>…\] {8}Where to start a board/);
  assert.match(DESIGN_HELP, /\nLegacy review flow\n {2}start /);
  assert.match(DESIGN_HELP, /\n {2}dev {22}Open the Design page on this folder, as you save\n/);
  assert.doesNotMatch(DESIGN_HELP, /capture/);
});

test('check prints each step, what changed per board and the problems, and exits 1 on one', async () => {
  const repo = repository();
  try {
    const run = terminal(
      repo.clone,
      checking(coordinator().api, () => checked(cutOff)),
    );
    const result = await runDesign('check', [], { project: 'site' }, run.deps);
    assert.equal(result.exitCode, 1);
    assert.equal(
      run.text(),
      [
        '! Drawn by deploy.local            no browser here: this terminal has no browser',
        '✓ Named 4 new elements             layer IDs kept on the rest',
        '✓ Drew 3 boards beside main        1440 · 700 · light · dark   12 s',
        '✗ Projects is cut off at 700 px    "Show archived" leaves the page',
        '',
        '  Board      What changed',
        '  Sidebar    Tasks grouped under their project',
        '  Projects   New Show menu · cut off at 700 px',
        '  Project    Breadcrumb back to Projects',
        '',
        'Before and after, side by side:  output/design/pairs',
        '',
        '1 problem. Fix Projects, then:',
        '  deploy design check',
        '',
      ].join('\n'),
    );
    const clean = terminal(
      repo.clone,
      checking(coordinator().api, () => checked()),
    );
    assert.equal((await runDesign('check', [], { project: 'site' }, clean.deps)).exitCode, 0);
    assert.match(
      clean.text(),
      /No problems\. Next: commit the boards with the code they picture:\n {2}git commit -am "…"\n$/,
    );
  } finally {
    repo.cleanup();
  }
});

test('check follows the drawing as a job, shows how far it is, and prints the same result', async () => {
  const repo = repository();
  try {
    const states = [
      { state: 'running', drawn: 0, total: null },
      { state: 'running', drawn: 1, total: 3 },
      { state: 'running', drawn: 2, total: 3 },
      { state: 'done', drawn: 3, total: 3, result: checked(cutOff) },
    ];
    const asked = [];
    const following =
      (api) =>
      async (path, options = {}) => {
        if (path.endsWith('/check')) {
          asked.push(JSON.parse(options.body));
          return { check: { id: 'job-1' } };
        }
        if (path.endsWith('/check/job-1')) return states.shift();
        return api(path, options);
      };
    const sync = terminal(
      repo.clone,
      checking(coordinator().api, () => checked(cutOff)),
    );
    await runDesign('check', [], { project: 'site' }, sync.deps);
    const run = terminal(repo.clone, following(coordinator().api));
    const result = await runDesign('check', [], { project: 'site' }, run.deps);
    assert.equal(result.exitCode, 1);
    assert.equal(asked[0].follow, true);
    assert.equal(states.length, 0, 'read until done');
    assert.equal(run.text(), sync.text(), 'the same report as a check answered at once');

    // In a terminal, one line says how far it is and is cleared before the report.
    states.push(
      { state: 'running', drawn: 1, total: 2 },
      { state: 'done', drawn: 2, total: 2, result: checked() },
    );
    const live = terminal(repo.clone, following(coordinator().api), { spinner: true });
    await runDesign('check', [], { project: 'site' }, live.deps);
    const clear = '\r\x1b[2K';
    assert.ok(live.text().startsWith(clear), live.text());
    const [progress, rest] = live.text().slice(clear.length).split(clear);
    assert.match(progress, /^. Drawing 1 of 2 boards +beside main, on deploy\.local$/);
    assert.match(rest, /^! Drawn by deploy.local .*\n✓ Named/);

    // A check that fails on deploy.local fails here, with its words.
    states.push({
      state: 'failed',
      drawn: 0,
      total: null,
      error: { message: 'Push the working copy first', status: 404 },
    });
    const failing = terminal(repo.clone, following(coordinator().api));
    await assert.rejects(runDesign('check', [], { project: 'site' }, failing.deps), {
      message: 'Push the working copy first',
      status: 404,
    });
  } finally {
    repo.cleanup();
  }
});

test('check lists a shared part as one row, and --drop-instances leaves its boards to the landing', async () => {
  const repo = repository();
  const part = (dropped, carried) => ({
    named: 0,
    drawn: 1,
    widths: [1440, 700],
    schemes: ['light', 'dark'],
    seconds: 3,
    ...(dropped === undefined ? {} : { dropped }),
    boards: [
      {
        file: 'part:sidebar',
        part: 'sidebar',
        title: 'Sidebar',
        status: 'part',
        words: '242 screens',
        problems: carried ? ['carried on 234 screens'] : [],
      },
      { file: 'Welcome.html', title: 'Welcome', words: 'Title · Greeting', problems: [] },
    ],
    problems: carried
      ? [
          {
            file: 'part:sidebar',
            label: 'Sidebar is carried on 234 screens',
            detail: 'landing draws them; run deploy design check --drop-instances',
            short: 'carried on 234 screens',
          },
        ]
      : [],
    pairs: 'output/design/pairs',
  });
  try {
    const asked = [];
    const carried = terminal(
      repo.clone,
      checking(coordinator().api, (body) => (asked.push(body.drop), part(undefined, true))),
    );
    assert.equal((await runDesign('check', [], { project: 'site' }, carried.deps)).exitCode, 1);
    assert.equal(
      carried.text(),
      [
        '! Drawn by deploy.local            no browser here: this terminal has no browser',
        '✓ Named 0 new elements             layer IDs kept on the rest',
        '✓ Drew 1 board beside main         1440 · 700 · light · dark   3 s',
        '✗ Sidebar is carried on 234 screens landing draws them; run deploy design check --drop-instances',
        '',
        '  Board     What changed',
        '  Sidebar   242 screens · carried on 234 screens',
        '  Welcome   Title · Greeting',
        '',
        'Before and after, side by side:  output/design/pairs',
        '',
        '1 problem. Fix Sidebar, then:',
        '  deploy design check --drop-instances',
        '',
      ].join('\n'),
    );
    const dropping = terminal(
      repo.clone,
      checking(coordinator().api, (body) => (asked.push(body.drop), part(234, false))),
    );
    const result = await runDesign(
      'check',
      [],
      { project: 'site', 'drop-instances': true },
      dropping.deps,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.json.dropped, 234);
    assert.equal(
      dropping.text(),
      [
        '! Drawn by deploy.local            no browser here: this terminal has no browser',
        '✓ Restored 234 boards to main      landing draws their instances',
        '✓ Named 0 new elements             layer IDs kept on the rest',
        '✓ Drew 1 board beside main         1440 · 700 · light · dark   3 s',
        '',
        '  Board     What changed',
        '  Sidebar   242 screens',
        '  Welcome   Title · Greeting',
        '',
        'Before and after, side by side:  output/design/pairs',
        '',
        'No problems. Next: commit the boards with the code they picture:',
        '  git commit -am "…"',
        '',
      ].join('\n'),
    );
    assert.deepEqual(asked, [false, true]);
  } finally {
    repo.cleanup();
  }
});

test('propose refuses a problem, then checks, pushes and asks, ending with the next command', async () => {
  const repo = repository();
  try {
    await runDesign(
      'start',
      ['Sidebar by project'],
      { project: 'site' },
      terminal(repo.clone, coordinator().api).deps,
    );
    const folder = join(repo.root, 'deploy.local-sidebar-by-project');
    writeFileSync(join(folder, 'design/boards/Sidebar.html'), '<p data-layer="name">Project</p>');
    git(['commit', '-qam', 'The sidebar groups tasks under their project.'], folder);
    const flags = { project: 'site', 'look-at': 'Sidebar, Projects' };

    const refused = coordinator();
    const bad = terminal(
      folder,
      checking(refused.api, () => checked(cutOff)),
    );
    assert.equal((await runDesign('propose', [], flags, bad.deps)).exitCode, 1);
    assert.equal(refused.calls.length, 0, 'nothing is proposed with a problem in it');
    assert.equal(git(['ls-remote', '--heads', 'origin', 'design/sidebar-by-project'], folder), '');

    const server = coordinator([
      {
        branch: 'design/sidebar-by-project',
        owner: 'Gabriel',
        review: { boards: 3, state: 'waiting' },
      },
    ]);
    const run = terminal(
      folder,
      checking(server.api, () => checked()),
    );
    const result = await runDesign('propose', [], flags, run.deps);
    assert.equal(result.exitCode, 0);
    assert.equal(
      run.text(),
      [
        'Title     Sidebar by project',
        'Summary   The sidebar groups tasks under their project.',
        'Look at   Sidebar, Projects',
        '',
        '✓ Checked 3 boards                 no problems',
        '✓ Pushed                           design/sidebar-by-project',
        '! Waiting on Gabriel               Sidebar by project · 3 boards',
        '  deploy.local/dashboard/inbox · Waiting on you',
        '',
        'Hear back with:',
        '  deploy design feedback --wait',
        '',
      ].join('\n'),
    );
    assert.notEqual(
      git(['ls-remote', '--heads', 'origin', 'design/sidebar-by-project'], folder),
      '',
    );
    assert.deepEqual(server.calls[0], {
      path: '/api/projects/site/design/propose',
      method: 'POST',
      body: {
        ref: 'design/sidebar-by-project',
        title: 'Sidebar by project',
        summary: 'The sidebar groups tasks under their project.',
        lookAt: ['Sidebar', 'Projects'],
      },
    });

    // Work that is not committed would not reach the review.
    writeFileSync(join(folder, 'design/boards/Sidebar.html'), '<p data-layer="name">Edit</p>');
    await assert.rejects(
      () =>
        runDesign(
          'propose',
          [],
          flags,
          terminal(
            folder,
            checking(coordinator().api, () => checked()),
          ).deps,
        ),
      /not committed/,
    );
    // Not on a design branch: a usage error.
    await assert.rejects(
      () => runDesign('propose', [], flags, terminal(repo.clone, coordinator().api).deps),
      (error) => error.exitCode === 2,
    );
  } finally {
    repo.cleanup();
  }
});

// Live: a proposal read "Start screens scenario carousel on phones full w", the branch name cut
// to 48 letters. Propose sends the title given to start, else the first commit's subject.
test('propose titles a proposal with the words given to start, never the cut branch name', async () => {
  const repo = repository();
  try {
    const title = 'Start screens: scenario carousel on phones, full width';
    await runDesign(
      'start',
      [title],
      { project: 'site' },
      terminal(repo.clone, coordinator().api).deps,
    );
    const branch = 'design/start-screens-scenario-carousel-on-phones-full-w';
    const folder = join(repo.root, 'deploy.local-start-screens-scenario-carousel-on-phones-full-w');
    writeFileSync(join(folder, 'design/boards/Sidebar.html'), '<p data-layer="name">Start</p>');
    git(['commit', '-qam', 'Draw the start screens as a carousel'], folder);
    const flags = { project: 'site', summary: 'Phones get a carousel.', 'look-at': 'Sidebar' };
    const propose = async () => {
      const server = coordinator([
        { branch, owner: 'Gabriel', review: { boards: 1, state: 'waiting' } },
      ]);
      const run = terminal(
        folder,
        checking(server.api, () => checked()),
      );
      assert.equal((await runDesign('propose', [], flags, run.deps)).exitCode, 0);
      return server.calls[0].body.title;
    };
    assert.equal(await propose(), title);
    // A branch made without start has no description: its first commit names it.
    git(['config', '--unset', `branch.${branch}.description`], folder);
    assert.equal(await propose(), 'Draw the start screens as a carousel');
  } finally {
    repo.cleanup();
  }
});

const asked = {
  branch: 'design/sidebar-by-project',
  owner: 'Gabriel',
  review: {
    id: 'design:site:design~sidebar-by-project:abc',
    title: 'Sidebar by project',
    round: 1,
    state: 'answered',
    proposedAt: '2026-11-17T12:00:00Z',
    answer: { actionId: 'changes', at: '2026-11-17T12:03:40Z', by: 'Gabriel' },
    note: 'Close. Two things on the sidebar and the menu.',
    pins: [
      {
        number: 1,
        boardTitle: 'Sidebar',
        layerName: 'project name',
        text: 'Keep the project name bold.',
      },
      {
        number: 2,
        boardTitle: 'Projects',
        layerName: 'Show menu',
        text: 'Archived starts hidden.',
      },
    ],
    landing: null,
  },
};
const waitingOn = {
  ...asked,
  review: { ...asked.review, state: 'waiting', answer: null, pins: [], note: null },
};

test('feedback says it is waiting (exit 3), and --wait stays until the notes arrive, numbered', async () => {
  const repo = repository();
  try {
    await runDesign(
      'start',
      ['Sidebar by project'],
      { project: 'site' },
      terminal(repo.clone, coordinator().api).deps,
    );
    const folder = join(repo.root, 'deploy.local-sidebar-by-project');
    const once = terminal(folder, coordinator([waitingOn]).api);
    assert.equal((await runDesign('feedback', [], { project: 'site' }, once.deps)).exitCode, 3);
    assert.equal(
      once.text(),
      '! Waiting on Gabriel               4 min\n\nHear back with:\n  deploy design feedback --wait\n',
    );

    const server = coordinator([waitingOn, waitingOn, asked]);
    const run = terminal(folder, server.api);
    const result = await runDesign('feedback', [], { project: 'site', wait: true }, run.deps);
    assert.equal(result.exitCode, 0);
    assert.equal(
      run.text(),
      [
        '⠋ Waiting on Gabriel               4 min',
        '! Gabriel asked for changes        round 1 · just now',
        '  "Close. Two things on the sidebar and the menu."',
        '',
        '  1  Sidebar · project name   Keep the project name bold.',
        '  2  Projects · Show menu     Archived starts hidden.',
        '',
        'Answer each note when it is done, then propose again:',
        '  deploy design resolve 1 "What you did"',
        '  deploy design propose',
        '',
      ].join('\n'),
    );
    // While it waits, the coordinator hears that a terminal on this computer is waiting.
    assert.ok(
      server.calls.every(
        (call) =>
          call.path === '/api/projects/site/design/feedback/wait' &&
          call.body.computer === 'MacBook Pro' &&
          call.body.branch === 'design/sidebar-by-project',
      ),
    );
  } finally {
    repo.cleanup();
  }
});

test('an approved, landed design removes the branch and this folder, and says where to go', async () => {
  const repo = repository();
  try {
    await runDesign(
      'start',
      ['Sidebar by project'],
      { project: 'site' },
      terminal(repo.clone, coordinator().api).deps,
    );
    const folder = join(repo.root, 'deploy.local-sidebar-by-project');
    const approved = {
      ...asked,
      review: {
        ...asked.review,
        round: 2,
        answer: { actionId: 'approve', at: '2026-11-17T12:03:40Z', by: 'Gabriel' },
        pins: [],
        note: null,
        landing: {
          state: 'landed',
          commit: '4f05991abcdef',
          branch: { name: 'design/sidebar-by-project', removed: true },
        },
      },
    };
    const run = terminal(folder, coordinator([approved]).api, { home: repo.root });
    const result = await runDesign('feedback', [], { project: 'site', wait: true }, run.deps);
    assert.equal(result.exitCode, 0);
    assert.equal(
      run.text(),
      [
        '✓ Gabriel approved it              round 2 · on main as 4f05991',
        '✓ Removed design/sidebar-by-project on origin and here',
        '✓ Removed its folder               cd ~/deploy.local',
        '',
      ].join('\n'),
    );
    assert.equal(existsSync(folder), false);
    assert.equal(git(['branch', '--list', 'design/sidebar-by-project'], repo.clone), '');
  } finally {
    repo.cleanup();
  }
});

test('a folder with work that is not committed is kept after landing', async () => {
  const repo = repository();
  try {
    await runDesign(
      'start',
      ['Kept'],
      { project: 'site' },
      terminal(repo.clone, coordinator().api).deps,
    );
    const folder = join(repo.root, 'deploy.local-kept');
    writeFileSync(join(folder, 'notes.txt'), 'still working');
    const landed = {
      ...asked,
      branch: 'design/kept',
      review: {
        ...asked.review,
        answer: { actionId: 'approve', at: '2026-11-17T12:03:40Z' },
        landing: { state: 'landed', commit: 'abcdef1234', branch: { removed: true } },
      },
    };
    const run = terminal(folder, coordinator([landed]).api);
    assert.equal((await runDesign('feedback', [], { project: 'site' }, run.deps)).exitCode, 0);
    assert.match(
      run.text(),
      /Kept this folder and design\/kept: it has changes that are not committed/,
    );
    assert.ok(existsSync(folder));
  } finally {
    repo.cleanup();
  }
});

test('resolve answers a note by its number, through the coordinator, and says what is next', async () => {
  const repo = repository();
  try {
    await runDesign(
      'start',
      ['Sidebar by project'],
      { project: 'site' },
      terminal(repo.clone, coordinator().api).deps,
    );
    const folder = join(repo.root, 'deploy.local-sidebar-by-project');
    const server = coordinator();
    const run = terminal(folder, server.api);
    const result = await runDesign('resolve', ['1', 'Bold again'], { project: 'site' }, run.deps);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(server.calls, [
      {
        path: '/api/projects/site/design/feedback/resolve',
        method: 'POST',
        body: { branch: 'design/sidebar-by-project', pin: 1, reply: 'Bold again' },
      },
    ]);
    assert.equal(
      run.text(),
      '✓ Note 1 is done                   "Bold again"\n\nWhen every note is done, propose again:\n  deploy design propose\n',
    );
    for (const args of [[], ['one', 'x'], ['1']])
      await assert.rejects(
        () => runDesign('resolve', args, { project: 'site' }, run.deps),
        (error) => error.exitCode === 2,
      );
  } finally {
    repo.cleanup();
  }
});

test('--json prints nothing but the result; colour only for a terminal that wants it', async () => {
  const repo = repository();
  try {
    const json = terminal(
      repo.clone,
      checking(coordinator().api, () => checked(cutOff)),
      {
        color: true,
      },
    );
    const result = await runDesign('check', [], { project: 'site', json: true }, json.deps);
    assert.equal(json.text(), '');
    assert.equal(result.exitCode, 1);
    assert.equal(result.json.problems[0].label, 'Projects is cut off at 700 px');
    const coloured = terminal(
      repo.clone,
      checking(coordinator().api, () => checked(cutOff)),
      {
        color: true,
      },
    );
    await runDesign('check', [], { project: 'site' }, coloured.deps);
    const escape = String.fromCharCode(27);
    assert.ok(coloured.text().includes(`${escape}[31m✗${escape}[0m Projects`));
    const plain = terminal(
      repo.clone,
      checking(coordinator().api, () => checked(cutOff)),
    );
    await runDesign('check', [], { project: 'site' }, plain.deps);
    assert.ok(!plain.text().includes(escape));
    await assert.rejects(
      () => runDesign('nope', [], {}, plain.deps),
      (error) => error.exitCode === 2 && /Unknown design command/.test(error.message),
    );
  } finally {
    repo.cleanup();
  }
});

test('deploy design --help, -h and deploy help design print the design help; --json wraps it', () => {
  const deploy = (args) =>
    execFileSync(process.execPath, [join(import.meta.dirname, 'deploy.js'), ...args], {
      cwd: tmpdir(),
      encoding: 'utf8',
      env: { ...process.env, HOME: tmpdir() },
    });
  for (const args of [
    ['design', '--help'],
    ['design', '-h'],
    ['help', 'design'],
  ])
    assert.equal(deploy(args), `${DESIGN_HELP}\n`);
  assert.deepEqual(JSON.parse(deploy(['help', 'design', '--json'])), { help: DESIGN_HELP });
  assert.match(deploy(['--help']), /^deploy — ship and run apps/);
});

test('check sends this folder as it is, then writes back layer IDs, restored boards and the pairs', async () => {
  const repo = repository();
  try {
    await runDesign(
      'start',
      ['Harbor trade'],
      { project: 'site' },
      terminal(repo.clone, coordinator().api).deps,
    );
    const folder = join(repo.root, 'deploy.local-harbor-trade');
    const head = git(['rev-parse', 'HEAD'], folder);
    const main = git(['rev-parse', 'origin/main'], folder);
    // A new board nobody has added to Git, and a change to one that is.
    writeFileSync(join(folder, 'design/boards/Trade.html'), '<main><p>Offer 2 brick</p></main>\n');
    writeFileSync(join(folder, 'design/boards/Sidebar.html'), '<p data-layer="name">Carried</p>');
    const sent = [];
    const answer = (body) => {
      const read = (path) => git(['show', `${body.ref}:${path}`], repo.origin);
      sent.push({
        ref: body.ref,
        drop: body.drop,
        trade: read('design/boards/Trade.html'),
        sidebar: read('design/boards/Sidebar.html'),
        parent: git(['rev-parse', `${body.ref}^`], repo.origin),
      });
      return {
        ...checked(),
        layers: {
          'Trade.html': '<main data-layer="main"><p data-layer="offer">Offer 2 brick</p></main>',
        },
        restore: [{ commit: main, files: ['Sidebar.html'] }],
        pictures: [
          { name: 'Trade-1440-light.png', png: Buffer.from('pair').toString('base64') },
          { name: '../escape.png', png: Buffer.from('no').toString('base64') },
        ],
      };
    };
    const run = terminal(folder, checking(coordinator().api, answer));
    const result = await runDesign(
      'check',
      [],
      { project: 'site', 'drop-instances': true },
      run.deps,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(sent.length, 1);
    assert.match(sent[0].ref, /^refs\/design-check\/harbor-trade-[0-9a-f]{12}$/);
    assert.equal(sent[0].drop, true);
    assert.equal(sent[0].trade, '<main><p>Offer 2 brick</p></main>');
    assert.equal(sent[0].sidebar, '<p data-layer="name">Carried</p>');
    assert.equal(sent[0].parent, head);
    // The folder's branch and index are as they were; only the files changed.
    assert.equal(git(['rev-parse', 'HEAD'], folder), head);
    assert.equal(git(['diff', '--cached', '--name-only'], folder), '');
    assert.equal(
      readFileSync(join(folder, 'design/boards/Trade.html'), 'utf8'),
      '<main data-layer="main"><p data-layer="offer">Offer 2 brick</p></main>\n',
    );
    assert.equal(
      readFileSync(join(folder, 'design/boards/Sidebar.html'), 'utf8'),
      '<p data-layer="name">Name</p>',
    );
    assert.equal(
      readFileSync(join(folder, 'output/design/pairs/Trade-1440-light.png'), 'utf8'),
      'pair',
    );
    assert.equal(existsSync(join(folder, 'output/escape.png')), false);
    assert.equal(existsSync(join(folder, 'output/design/escape.png')), false);
    assert.equal('pictures' in result.json || 'layers' in result.json, false);

    // deploy.local removes the ref after a check; one it could not finish, the terminal removes.
    git(['update-ref', '-d', sent[0].ref], repo.origin);
    const failing = terminal(
      folder,
      checking(coordinator().api, () => {
        throw Object.assign(new Error('503: Rendering boards needs Chromium'), { status: 503 });
      }),
    );
    await assert.rejects(
      () => runDesign('check', [], { project: 'site' }, failing.deps),
      /Rendering boards/,
    );
    assert.equal(git(['for-each-ref', 'refs/design-check'], repo.origin), '');
  } finally {
    repo.cleanup();
  }
});

test('dev serves the Design page on this folder, prints a line per save, and stops on Ctrl-C', async () => {
  const repo = repository();
  try {
    await runDesign(
      'start',
      ['Harbor trade'],
      { project: 'site' },
      terminal(repo.clone, coordinator().api).deps,
    );
    const folder = join(repo.root, 'deploy.local-harbor-trade');
    let served;
    const run = terminal(folder, coordinator().api, {
      now: () => new Date(2026, 10, 17, 12, 4, 10).getTime(),
      serveDesign: async (options) => {
        served = options;
        let stop;
        const stopped = new Promise((resolve) => (stop = resolve));
        setImmediate(() => {
          options.onSave({ file: 'Harbor.html', problems: [] });
          options.onSave({
            file: 'Trade.html',
            problems: [
              {
                file: 'Trade.html',
                short: 'links to Market.html',
                detail: 'no board has that name',
              },
            ],
          });
          stop();
        });
        return { url: 'http://localhost:5199', stopped };
      },
    });
    const result = await runDesign('dev', [], {}, run.deps);
    assert.equal(result.exitCode, 0);
    assert.equal(
      run.text(),
      [
        '✓ Design page for this folder      http://localhost:5199',
        '  The same page as on deploy.local, on your files. It follows each save.',
        '  Comments, review and agents are on deploy.local.',
        '',
        '  12:04:10  Harbor   saved',
        '✗ 12:04:10  Trade    links to Market.html · no board has that name',
        '',
        'Stopped. Ask for review with:',
        '  deploy design propose',
        '',
      ].join('\n'),
    );
    assert.equal(served.root, folder);
    assert.equal(served.project, 'deploy.local');
    assert.equal(served.branch, 'design/harbor-trade');
    assert.equal(served.main, 'origin/main');
    // A folder with no design has nothing to show.
    rmSync(join(folder, 'design/canvas.json'));
    await assert.rejects(
      () => runDesign('dev', [], {}, run.deps),
      (error) => error.message === 'This folder has no design yet.' && error.exitCode === 1,
    );
  } finally {
    repo.cleanup();
  }
});

/**
 * Every file inside .git with its size and time: what a check must leave as it was. Objects are
 * listed without their time: Git may touch an object it already has instead of writing it again,
 * and where it cannot (a read-only .git) it writes the copy into the check's own folder.
 */
function gitFolder(folder) {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], folder);
  const own = git(['rev-parse', '--path-format=absolute', '--git-dir'], folder);
  const seen = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        const name = relative(common, path);
        const time = name.startsWith('objects/') ? '' : ` ${statSync(path).mtimeMs}`;
        seen.push(`${name} ${statSync(path).size}${time}`);
      }
    }
  };
  walk(common);
  if (own !== common && !own.startsWith(`${common}/`)) walk(own);
  return seen.sort().join('\n');
}

test('check runs on this computer on any branch, writes nothing in .git, and --fix writes heights', async () => {
  const repo = repository();
  try {
    git(['checkout', '-qb', 'kept-files'], repo.clone);
    // A board Git does not track yet, with a height its head and the canvas disagree on.
    writeFileSync(
      join(repo.clone, 'design/boards/Kept.html'),
      '<meta name="design-board" content="width=1440,height=1100">\n<style>.row{color:#ffffff}</style><main><p class="row">Kept</p></main>\n',
    );
    writeFileSync(
      join(repo.clone, 'design/canvas.json'),
      JSON.stringify({
        title: 'Site',
        boards: {
          'Sidebar.html': { x: 0, y: 0, w: 1440, h: 900 },
          'Kept.html': { x: 2000, y: 0, w: 1440, h: 900 },
        },
      }),
    );
    const before = gitFolder(repo.clone);
    const drawn = [];
    let closed = 0;
    const openLocalDrawing = async () => ({
      executable: '/fake/chromium',
      drawing: {
        shoot: async ({ commit, file, width, scheme, inspect }) => {
          drawn.push(`${file} ${commit === ':worktree:' ? 'here' : 'main'} ${width} ${scheme}`);
          return {
            png: Buffer.from('png'),
            measured: null,
            inspected: inspect
              ? { height: 1240, texts: [], aligned: [], rows: {}, boxes: [], primaries: [] }
              : null,
          };
        },
        pair: async () => Buffer.from('pair'),
      },
      close: async () => closed++,
    });
    const run = terminal(repo.clone, coordinator().api, { openLocalDrawing });
    const result = await runDesign('check', [], { json: true }, run.deps);
    assert.equal(result.exitCode, 1);
    assert.equal(closed, 1);
    const json = result.json;
    for (const key of ['ok', 'code', 'message', 'fix', 'problems', 'notes', 'fixed', 'next'])
      assert.ok(key in json, key);
    assert.equal(json.ok, false);
    assert.equal(json.where, 'computer');
    assert.deepEqual(
      json.problems.map((problem) => problem.code),
      ['not_a_token', 'height_differs'],
    );
    assert.equal(json.next, 'deploy design check --fix');
    assert.ok(drawn.includes('Kept.html here 1440 light'));
    assert.equal(gitFolder(repo.clone), before, 'nothing inside .git changed');
    // New elements were named in the folder's own file.
    assert.match(
      readFileSync(join(repo.clone, 'design/boards/Kept.html'), 'utf8'),
      /data-layer="kept"/,
    );

    const fixed = terminal(repo.clone, coordinator().api, { openLocalDrawing });
    const again = await runDesign('check', [], { fix: true }, fixed.deps);
    assert.equal(again.exitCode, 1, 'the colour is still a problem');
    assert.deepEqual(
      again.json.problems.map((problem) => problem.code),
      ['not_a_token'],
    );
    assert.match(fixed.text(), /^✓ Checked on this computer +against origin\/main [0-9a-f]{7}\n/);
    assert.match(fixed.text(), /✓ Fixed +Kept is 1240 px tall in its meta and canvas.json/);
    assert.match(fixed.text(), /not_a_token · fix: /);
    assert.match(
      readFileSync(join(repo.clone, 'design/boards/Kept.html'), 'utf8'),
      /content="width=1440,height=1240"/,
    );
    assert.equal(
      JSON.parse(readFileSync(join(repo.clone, 'design/canvas.json'), 'utf8')).boards['Kept.html']
        .h,
      1240,
    );
    assert.equal(gitFolder(repo.clone), before, 'still nothing inside .git');
  } finally {
    repo.cleanup();
  }
});

test('with no browser, check falls back to deploy.local and still writes nothing in .git', async () => {
  const repo = repository();
  try {
    writeFileSync(
      join(repo.clone, 'design/boards/Sidebar.html'),
      '<p data-layer="name">Changed</p>',
    );
    const before = gitFolder(repo.clone);
    let sent;
    const answer = (body) => {
      sent = git(['show', `${body.ref}:design/boards/Sidebar.html`], repo.origin);
      return checked();
    };
    const run = terminal(repo.clone, checking(coordinator().api, answer), {
      openLocalDrawing: async () => ({ reason: 'no Chromium or Chrome on this computer' }),
    });
    const result = await runDesign('check', [], { project: 'site' }, run.deps);
    assert.equal(result.exitCode, 0);
    assert.equal(sent, '<p data-layer="name">Changed</p>');
    assert.match(
      run.text(),
      /^! Drawn by deploy.local +no browser here: no Chromium or Chrome on this computer\n/,
    );
    assert.equal(gitFolder(repo.clone), before);

    // deploy.local out of reach is exit 4.
    const away = terminal(
      repo.clone,
      async (path) => {
        if (path.endsWith('/check')) throw new Error('fetch failed');
        return coordinator().api(path);
      },
      { openLocalDrawing: async () => ({ reason: 'none' }) },
    );
    await assert.rejects(runDesign('check', [], { project: 'site' }, away.deps), {
      exitCode: 4,
    });
  } finally {
    repo.cleanup();
  }
});

test('status says where to start: platform, sizes, current or replaced, source, siblings, questions, other branches', async () => {
  const repo = repository();
  try {
    const board = (meta, body = '') =>
      `<meta name="design-board" content="${meta}">\n<main>${body}</main>\n`;
    const boards = {
      'Run.html': board(
        'width=1440,height=900; title=A run',
        '<p data-layer="kept" data-question="How long are files kept?">Kept</p>',
      ),
      'RunKept.html': board('width=1440,height=900'),
      'RunOld.html': board('width=1440,height=900'),
      'RunNew.html': board('width=1440,height=900; replaces=RunOld.html'),
      'Inbox.html': board('width=1440,height=900'),
      'InboxPhone.html': board('width=390,height=844'),
    };
    for (const [file, html] of Object.entries(boards))
      writeFileSync(join(repo.clone, 'design/boards', file), html);
    mkdirSync(join(repo.clone, 'design/ds/deploy-local/components'), { recursive: true });
    writeFileSync(
      join(repo.clone, 'design/ds/deploy-local/components/library.json'),
      JSON.stringify({
        components: [
          {
            id: 'list-group',
            name: 'List row',
            group: 'Lists',
            description: 'Rows in a group. More.',
            html: '',
          },
          {
            id: 'template-detail-phone',
            name: 'Detail, iPhone',
            group: 'Page templates',
            html: '',
          },
        ],
      }),
    );
    git(['add', '.'], repo.clone);
    git(['commit', '-qm', 'Boards'], repo.clone);
    git(['push', '-q', 'origin', 'main'], repo.clone);
    // Another branch on origin changes Run.html.
    git(['checkout', '-qb', 'sidebar'], repo.clone);
    writeFileSync(join(repo.clone, 'design/boards/Run.html'), board('width=1440,height=900', 'x'));
    git(['commit', '-qam', 'Sidebar'], repo.clone);
    git(['push', '-q', 'origin', 'sidebar'], repo.clone);
    git(['checkout', '-q', 'main'], repo.clone);
    git(['fetch', '-q', 'origin'], repo.clone);

    const run = terminal(repo.clone, coordinator().api);
    const result = await runDesign('status', ['Run', 'RunOld.html', 'RunPhone'], {}, run.deps);
    assert.equal(result.exitCode, 0);
    const [first, old, phone] = result.json.boards;
    assert.equal(first.platform, 'web');
    assert.deepEqual(first.sizes, [1440, 700]);
    assert.equal(first.current, true);
    assert.deepEqual(first.siblings.map((sibling) => sibling.file).sort(), [
      'RunKept.html',
      'RunNew.html',
      'RunOld.html',
    ]);
    assert.deepEqual(first.questions, [{ layer: 'kept', question: 'How long are files kept?' }]);
    assert.deepEqual(
      first.otherBranches.map((other) => other.branch),
      ['sidebar'],
    );
    assert.equal(old.current, false);
    assert.equal(old.replacedBy, 'RunNew.html');
    assert.equal(phone.exists, false);
    assert.equal(phone.platform, 'phone');
    assert.equal(phone.source, 'Run.html');
    assert.deepEqual(phone.templates, ['template-detail-phone']);
    assert.equal(phone.copyFrom, 'InboxPhone.html', 'the phone board of the closest web screen');
    const text = run.text();
    assert.match(text, /^Run\.html {2}web · 1440 and 700 · light, dark · current\n/);
    assert.match(text, /\n {2}Open question {3}kept: "How long are files kept\?"\n/);
    assert.match(text, /\n {2}Also changing {3}branch sidebar \(Test, /);
    assert.match(text, /\nRunOld\.html .* replaced by RunNew\.html\n/);
    assert.match(
      text,
      /\nRunPhone\.html {2}no board yet · phone · 390\n {2}Copy from {7}InboxPhone\.html, and put copied_from=InboxPhone\.html in its head\n {2}Source {10}Run\.html \(web\)/,
    );
    assert.match(
      text,
      /\nNext {2}edit design\/boards\/Run\.html, then deploy design check --fix\n$/,
    );

    // With no names: the boards this branch changed.
    git(['checkout', '-qb', 'mine'], repo.clone);
    writeFileSync(
      join(repo.clone, 'design/boards/Inbox.html'),
      board('width=1440,height=900', 'y'),
    );
    const changed = await runDesign(
      'status',
      [],
      { json: true },
      terminal(repo.clone, coordinator().api).deps,
    );
    assert.deepEqual(
      changed.json.boards.map((entry) => entry.file),
      ['Inbox.html'],
    );
    assert.deepEqual(changed.json.boards[0].siblings, [], 'InboxPhone is another platform');

    const guide = terminal(repo.clone, coordinator().api);
    await runDesign('guide', [], {}, guide.deps);
    assert.match(
      guide.text(),
      /^Design system\n {2}design\/ds\/deploy-local: components\/library.json\n\nPlatforms and sizes\n {2}web {5}1440 {2}drawn at 1440 and 700/,
    );
    assert.match(guide.text(), /\n {2}list-group {13}Rows in a group\n/);
    assert.match(guide.text(), /\n {2}low_contrast +problem {2}/);
    assert.match(guide.text(), /data-question=/);
    assert.match(guide.text(), /'Kept with this run\.'/);
    assert.doesNotMatch(guide.text(), /owner will set/);
    assert.match(guide.text(), /\n {2}3\. deploy design check --fix/);
  } finally {
    repo.cleanup();
  }
});

test('guide lists every code the check can report', async () => {
  const { checkCodes } = await import('../server/design/board-quality.ts');
  const listed = new Set(checkCodes.map((entry) => entry.code));
  const sources = [
    '../server/features/design/board-check.ts',
    '../server/design/board-quality.ts',
    '../shared/v2/design-overflow.ts',
  ]
    .map((path) => readFileSync(join(import.meta.dirname, path), 'utf8'))
    .join('\n');
  const used = new Set([...sources.matchAll(/\bcode: '([a-z_]+)'/g)].map((match) => match[1]));
  assert.deepEqual(
    [...used].filter((code) => !listed.has(code)),
    [],
  );
  assert.deepEqual(
    [...listed].filter((code) => !used.has(code)),
    [],
  );
});

test('guide reads the fixtures sentence, writes meta with commas and says where each icon comes from', async () => {
  const repo = repository();
  try {
    writeFileSync(
      join(repo.clone, 'design/README.md'),
      [
        '1. `deploy design guide` once: platforms, components, fixture names and the check codes.',
        '2. `deploy design status <Board>`: where to start.',
        '',
        'Use the fixture names from the boards: home-gym, tally, SER.',
      ].join('\n'),
    );
    mkdirSync(join(repo.clone, 'design/ds/deploy-local/components'), { recursive: true });
    writeFileSync(
      join(repo.clone, 'design/ds/deploy-local/components/library.json'),
      JSON.stringify({
        components: [
          {
            id: 'icon-check',
            name: 'Check',
            group: 'Icons and art',
            html: '<svg><path d="M5 12l5 5L20 7"/></svg>',
          },
          {
            id: 'icon-clock',
            name: 'Clock',
            group: 'Icons and art',
            html: '<svg><path d="M12 7v5l3 2"/></svg>',
          },
        ],
      }),
    );
    writeFileSync(
      join(repo.clone, 'design/boards/Run.html'),
      '<main><svg><path d="M5 12l5 5L20 7"/></svg></main>',
    );
    const run = terminal(repo.clone, coordinator().api);
    await runDesign('guide', [], {}, run.deps);
    const text = run.text();
    assert.match(
      text,
      /\nFixtures \(use these names, never invented ones\)\n {2}home-gym, tally, SER\n/,
    );
    assert.match(text, /content="width=390,height=844,platform=phone,source=Inbox\.html"/);
    assert.doesNotMatch(text, /content="[^"]*;/);
    assert.match(
      text,
      /\n {2}check {2}Run\.html\n {2}clock {2}design\/ds\/deploy-local\/components\/library\.json\n/,
    );
  } finally {
    repo.cleanup();
  }
});

test('status resolves a screen named in words to its board by section', async () => {
  const repo = repository();
  try {
    const board = (body = '') =>
      `<meta name="design-board" content="width=1440,height=900">\n<main>${body}</main>\n`;
    for (const file of [
      'DesignCanvas.html',
      'DesignBoard.html',
      'DesignReviewCanvas.html',
      'DesignReviewPin.html',
      'DesignReviewGrid.html',
    ])
      writeFileSync(join(repo.clone, 'design/boards', file), board());
    writeFileSync(
      join(repo.clone, 'design/canvas.json'),
      JSON.stringify({
        boards: {
          'DesignCanvas.html': { x: 0, y: 200, w: 1440, h: 900 },
          'DesignBoard.html': { x: 1600, y: 200, w: 1440, h: 900 },
          'DesignReviewCanvas.html': { x: 0, y: 2200, w: 1440, h: 900 },
          'DesignReviewPin.html': { x: 1600, y: 2200, w: 1440, h: 900 },
          'DesignReviewGrid.html': { x: 3200, y: 2200, w: 1440, h: 900 },
        },
        notes: {
          page: { x: 0, y: 0, text: 'The Design page', kind: 'title1' },
          review: { x: 0, y: 2000, text: 'Design review', kind: 'title1' },
        },
      }),
    );
    const run = terminal(repo.clone, coordinator().api);
    const result = await runDesign('status', ['DesignPage'], {}, run.deps);
    assert.equal(result.json.boards[0].means, 'DesignCanvas.html');
    assert.match(run.text(), /\n {2}Means {11}DesignCanvas\.html: work on that board/);
    assert.match(run.text(), /\nNext {2}deploy design status DesignCanvas\n$/);
    const review = await runDesign(
      'status',
      ['DesignReviewThing'],
      { json: true },
      terminal(repo.clone, coordinator().api).deps,
    );
    assert.equal(
      review.json.boards[0].means ?? review.json.boards[0].copyFrom,
      'DesignReviewCanvas.html',
    );
  } finally {
    repo.cleanup();
  }
});

test('check --fix places a new board beside the one it came from', async () => {
  const repo = repository();
  try {
    writeFileSync(
      join(repo.clone, 'design/boards/SidebarPhone.html'),
      '<meta name="design-board" content="width=390,height=844,source=Sidebar.html">\n<main><p data-layer="name">Name</p></main>\n',
    );
    const openLocalDrawing = async () => ({
      drawing: {
        shoot: async ({ inspect }) => ({
          png: Buffer.from('png'),
          measured: null,
          inspected: inspect
            ? { height: 844, texts: [], aligned: [], rows: {}, boxes: [], primaries: [] }
            : null,
        }),
        pair: async () => Buffer.from('pair'),
      },
      close: async () => {},
    });
    const first = await runDesign(
      'check',
      [],
      { json: true },
      terminal(repo.clone, coordinator().api, { openLocalDrawing }).deps,
    );
    const missing = first.json.problems.find((problem) => problem.code === 'not_on_canvas');
    assert.match(
      missing.fix,
      /^deploy design check --fix places it at x 1600, y 0, right of Sidebar\.html$/,
    );
    const fixed = await runDesign(
      'check',
      [],
      { json: true, fix: true },
      terminal(repo.clone, coordinator().api, { openLocalDrawing }).deps,
    );
    assert.equal(fixed.exitCode, 0);
    assert.deepEqual(fixed.json.fixed, [
      'SidebarPhone placed at x 1600, y 0 in canvas.json, right of Sidebar (it was not on the canvas)',
    ]);
    const canvas = JSON.parse(readFileSync(join(repo.clone, 'design/canvas.json'), 'utf8'));
    assert.deepEqual(canvas.boards['SidebarPhone.html'], {
      x: 1600,
      y: 0,
      w: 390,
      h: 844,
      title: 'SidebarPhone',
    });
  } finally {
    repo.cleanup();
  }
});

test('a clean check ends with the pairs to open and the questions a reviewer asks', async () => {
  const repo = repository();
  try {
    writeFileSync(
      join(repo.clone, 'design/boards/Sidebar.html'),
      '<p data-layer="name">Name, changed</p>',
    );
    const openLocalDrawing = async () => ({
      drawing: {
        shoot: async () => ({ png: Buffer.from('png'), measured: null, inspected: null }),
        pair: async () => Buffer.from('pair'),
      },
      close: async () => {},
    });
    const run = terminal(repo.clone, coordinator().api, { openLocalDrawing });
    const result = await runDesign('check', [], {}, run.deps);
    assert.equal(result.exitCode, 0);
    const pairs = [1440, 700].flatMap((width) =>
      ['light', 'dark'].map((scheme) => `output/design/pairs/Sidebar-${width}-${scheme}.png`),
    );
    assert.deepEqual(result.json.review, { pairs, questions: reviewQuestions });
    assert.deepEqual(result.json.pairs, pairs);
    assert.equal(reviewQuestions.length, 8);
    const text = run.text();
    assert.match(
      text,
      /\nOpen every one of these before you finish:\n {3}1\. output\/design\/pairs\/Sidebar-1440-light\.png\n/,
    );
    assert.match(
      text,
      /\n {2}8\. Is every open question asked with data-question instead of guessed\?\n$/,
    );
  } finally {
    repo.cleanup();
  }
});

test("status prints the design system's phone conventions for a new phone board", async () => {
  const repo = repository();
  try {
    mkdirSync(join(repo.clone, 'design/ds/site'), { recursive: true });
    writeFileSync(
      join(repo.clone, 'design/ds/site/README.md'),
      '# System\n\n## Phone screens\n\n- Detail screens have a back button and the title in the bar.\n- Rows are 52 px.\n\n## Lists\n\nOther.\n',
    );
    const run = terminal(repo.clone, coordinator().api);
    const result = await runDesign('status', ['SidebarPhone'], {}, run.deps);
    assert.deepEqual(result.json.boards[0].conventions, [
      'Detail screens have a back button and the title in the bar.',
      'Rows are 52 px.',
    ]);
    assert.match(
      run.text(),
      /\n {2}Conventions {5}Detail screens have a back button and the title in the bar\.\n {18}Rows are 52 px\.\n/,
    );
  } finally {
    repo.cleanup();
  }
});

test('sync draws instances again from their data-props on the changed boards, keeping IDs', async () => {
  const repo = repository();
  try {
    mkdirSync(join(repo.clone, 'design/ds/deploy-local/components'), { recursive: true });
    writeFileSync(
      join(repo.clone, 'design/ds/deploy-local/components/library.json'),
      JSON.stringify({
        components: [
          {
            id: 'tag',
            name: 'Tag',
            props: [{ id: 'label', default: 'Tag' }],
            html: '<span class="dl-tag"><b>{{label}}</b></span>',
          },
        ],
      }),
    );
    writeFileSync(
      join(repo.clone, 'design/boards/Sidebar.html'),
      '<main><span data-layer="kind" data-component="tag" data-props=\'{"label":"Package"}\'><b data-layer="kind-label">Old</b></span></main>\n',
    );
    const run = terminal(repo.clone, coordinator().api);
    const result = await runDesign('sync', [], {}, run.deps);
    assert.deepEqual(result.json.synced, ['Sidebar.html']);
    const html = readFileSync(join(repo.clone, 'design/boards/Sidebar.html'), 'utf8');
    assert.match(html, /<b data-layer="kind-label">Package<\/b>/);
    assert.match(run.text(), /^✓ Drew Sidebar again +1 instance\n\nNext: deploy design check\n$/);
    const again = await runDesign(
      'sync',
      ['Sidebar'],
      { json: true },
      terminal(repo.clone, coordinator().api).deps,
    );
    assert.deepEqual(again.json, {
      ok: true,
      code: 'synced',
      synced: [],
      unchanged: ['Sidebar.html'],
      next: 'deploy design check',
    });
    await assert.rejects(
      runDesign('sync', ['Nope'], {}, run.deps),
      (error) => error.exitCode === 2,
    );
  } finally {
    repo.cleanup();
  }
});

test('init starts design/ in an empty repository with the starter, here, and the rest point at it', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cli-design-init-')));
  try {
    const folder = join(root, 'larder');
    mkdirSync(folder);
    git(['init', '-q', '--initial-branch=main'], folder);
    const starter = {
      'tokens.css': Buffer.from(':root{--shelf:#f4efe6;--text-body:16px;--space-4:16px}\n'),
      'components.css': Buffer.from('.lr-row{padding:12px 16px}\n'),
      'library.json': Buffer.from(
        JSON.stringify({
          components: [
            {
              id: 'row',
              name: 'Row',
              description: 'A pantry row. More.',
              props: [],
              html: '<div class="lr-row"></div>',
            },
          ],
        }),
      ),
      'README.md': Buffer.from('# Larder design system\n'),
      'examples/PhoneScreen.html': Buffer.from(
        '<meta name="design-board" content="width=390,height=844">\n<main>Example</main>\n',
      ),
    };
    const run = (extra = {}) =>
      terminal(folder, coordinator().api, { starter: () => starter, ...extra });
    // Before init, every command says to run it.
    for (const sub of ['check', 'status', 'sync', 'guide'])
      await assert.rejects(
        runDesign(sub, [], {}, run().deps),
        (error) => error.next === 'deploy design init' && error.exitCode === 1,
      );
    const made = run();
    const result = await runDesign('init', [], {}, made.deps);
    assert.equal(result.exitCode, 0);
    assert.equal(result.json.name, 'larder');
    assert.match(
      made.text(),
      /Next: deploy design guide, then draw your first board in design\/boards\/\n$/,
    );
    const canvas = JSON.parse(readFileSync(join(folder, 'design/canvas.json'), 'utf8'));
    assert.deepEqual(canvas, {
      title: 'larder',
      designSystem: 'ds/larder',
      schemes: ['light', 'dark'],
      boards: {},
      order: [],
      notes: {},
    });
    assert.ok(existsSync(join(folder, 'design/boards')));
    assert.equal(
      readFileSync(join(folder, 'design/ds/larder/examples/PhoneScreen.html'), 'utf8'),
      starter['examples/PhoneScreen.html'].toString(),
    );
    assert.match(
      readFileSync(join(folder, 'design/README.md'), 'utf8'),
      /deploy design check --fix/,
    );
    // Nothing on a branch, no worktree, nothing sent.
    assert.equal(git(['branch', '--show-current'], folder), 'main');
    // Again: refused politely.
    await assert.rejects(runDesign('init', [], {}, run().deps), /already has design/);

    // The guide reads Larder's own system, never deploy.local's.
    const guide = run({ designSystem: () => Buffer.from('deploy.local tokens') });
    await runDesign('guide', [], {}, guide.deps);
    const text = guide.text();
    assert.match(
      text,
      /^Design system\n {2}design\/ds\/larder: tokens\.css, library\.json, components\.css, README\.md, examples\n {2}Examples to start from: design\/ds\/larder\/examples\/PhoneScreen\.html\n/,
    );
    assert.match(text, /\nType scale \(px, from tokens\.css\)\n {2}16\n/);
    assert.match(
      text,
      /\nComponents \(design\/ds\/larder\/library\.json\)\n {2}row {2}A pantry row\n/,
    );
    assert.doesNotMatch(text, /deploy-local|button-primary/);

    // A first board starts from the starter's examples.
    const status = run();
    const first = await runDesign('status', ['Pantry'], {}, status.deps);
    assert.deepEqual(
      first.json.components.map((component) => component.id),
      ['row'],
    );
    assert.match(
      status.text(),
      /\n {2}First board {5}start from the starter's examples in design\/ds\/larder\/: PhoneScreen\.html\n/,
    );
    assert.match(
      status.text(),
      /\nNext {2}copy design\/ds\/larder\/examples\/PhoneScreen\.html to design\/boards\/Pantry\.html/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('guide in a project with design/ but no design system says so and points at init', async () => {
  const repo = repository();
  try {
    const run = terminal(repo.clone, coordinator().api, { designSystem: () => Buffer.from('{}') });
    await runDesign('guide', [], {}, run.deps);
    assert.match(
      run.text(),
      /^Design system\n {2}This project has no design system yet\.\n {2}deploy design init/,
    );
    assert.doesNotMatch(run.text(), /deploy-local/);
  } finally {
    repo.cleanup();
  }
});

test("init copies the real starter, with its examples pointing at this project's system", async () => {
  const { designStarterFiles } = await import('./design-local-assets.mjs');
  const starter = designStarterFiles();
  assert.ok(starter['tokens.css'] && starter['library.json'], 'the CLI carries the starter');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cli-design-starter-')));
  try {
    git(['init', '-q', '--initial-branch=main'], root);
    const result = await runDesign(
      'init',
      ['Larder'],
      { json: true },
      terminal(root, coordinator().api, { starter: () => starter }).deps,
    );
    assert.equal(result.json.name, 'larder');
    // The kinds' files are copied only by init --kind.
    for (const path of Object.keys(starter).filter((entry) => !entry.startsWith('kinds/'))) {
      const copied = readFileSync(join(root, 'design/ds/larder', path), 'utf8');
      assert.doesNotMatch(copied, /__DS__/, path);
    }
    const example = Object.keys(starter).find((path) => path.startsWith('examples/'));
    assert.match(
      readFileSync(join(root, 'design/ds/larder', example), 'utf8'),
      /\.\.\/ds\/larder\/tokens\.css/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('init writes the agent checklist, and review briefs a second agent on the changed boards', async () => {
  const { INIT_README, reviewBrief } = await import('./cli-design.mjs');
  const readme = INIT_README('larder');
  assert.match(readme, /## What agents get wrong/);
  assert.match(readme, /deploy design review/);
  assert.match(readme, /ds\/larder\/README\.md/);
  const brief = reviewBrief({ top: '/p', boards: ['Pantry.html', 'PantryPhone.html'] });
  assert.match(brief, /design\/boards\/Pantry\.html/);
  assert.match(brief, /design\/boards\/PantryPhone\.html/);
  assert.match(brief, /\[fact\]/);
  assert.match(brief, /\[judgement\]/);
});

test('init --kind copies the base, then the kind over it: css, rules, components, examples, canvas kind and schemes', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cli-design-kind-')));
  try {
    git(['init', '-q', '--initial-branch=main'], root);
    const starter = {
      'tokens.css': Buffer.from(':root{--space-4:16px}\n'),
      'library.json': Buffer.from(
        JSON.stringify({ components: [{ id: 'row', name: 'Row', html: '<div></div>' }] }),
      ),
      'README.md': Buffer.from('# Base rules\n'),
      'examples/Base.html': Buffer.from('<link href="../ds/__DS__/tokens.css">'),
      'kinds/print/print.css': Buffer.from(':root{--text-print-body:8pt;--text-print-name:11pt}\n'),
      'kinds/print/print.md': Buffer.from('## Print\nKeep type 4 mm inside the trim.\n'),
      'kinds/print/library-print.json': Buffer.from(
        JSON.stringify({ components: [{ id: 'card', name: 'Card', html: '<div></div>' }] }),
      ),
      'kinds/print/examples/CardFront.html': Buffer.from(
        '<title>Example card</title><link href="../ds/__DS__/print.css"><meta name="design-board" content="platform=print,size=85x55mm,bleed=3mm,safe=4mm">',
      ),
      'kinds/doc/doc.css': Buffer.from(':root{--text-doc-body:11pt}\n'),
    };
    const made = terminal(root, coordinator().api, { starter: () => starter });
    const result = await runDesign('init', ['cards'], { kind: 'print' }, made.deps);
    assert.equal(result.json.kind, 'print');
    const ds = (path) => readFileSync(join(root, 'design/ds/cards', path), 'utf8');
    assert.match(ds('README.md'), /^# Base rules\n\n## Print\nKeep type 4 mm inside the trim\.\n$/);
    assert.deepEqual(
      JSON.parse(ds('library.json')).components.map((component) => component.id),
      ['card'],
      'a kind other than app leaves the app components out of the library',
    );
    assert.match(ds('print.css'), /--text-print-body:8pt/);
    assert.match(ds('examples/CardFront.html'), /\.\.\/ds\/cards\/print\.css/);
    assert.equal(
      existsSync(join(root, 'design/ds/cards/examples/Base.html')),
      false,
      'the app examples are not copied into another kind',
    );
    assert.equal(existsSync(join(root, 'design/ds/cards/kinds')), false);
    assert.equal(existsSync(join(root, 'design/ds/cards/doc.css')), false, 'only the chosen kind');
    const canvas = JSON.parse(readFileSync(join(root, 'design/canvas.json'), 'utf8'));
    assert.equal(canvas.kind, 'print');
    assert.deepEqual(canvas.schemes, ['light']);
    // The kind's starting board is in boards/ and on the canvas at its own size.
    assert.match(
      readFileSync(join(root, 'design/boards/CardFront.html'), 'utf8'),
      /\.\.\/ds\/cards\/print\.css/,
    );
    assert.deepEqual(canvas.boards['CardFront.html'], {
      x: 0,
      y: 0,
      w: 344,
      h: 231,
      title: 'Example card',
    });
    assert.deepEqual(canvas.order, ['CardFront.html']);

    // guide says the kind, its platform and size, and the kind's own type scale.
    const guide = terminal(root, coordinator().api, {});
    await runDesign('guide', [], {}, guide.deps);
    assert.match(guide.text(), /\nKind\n {2}This project makes print pieces/);
    assert.match(
      guide.text(),
      /print {3}344 {3}drawn at 85×55 mm trim, 3 mm bleed, 4 mm safe, at 8 px\/mm, light · 1 board\n/,
    );
    assert.match(
      guide.text(),
      /Type scale for print[^\n]*\n {2}--text-print-body +8pt\n {2}--text-print-name +11pt\n/,
    );
    // status names a new board by the project's kind.
    const status = terminal(root, coordinator().api, {});
    const asked = await runDesign('status', ['Menu'], {}, status.deps);
    assert.equal(asked.json.boards[0].platform, 'print');
    assert.match(status.text(), /Menu\.html {2}no board yet · print · 85×55 mm trim/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('init --kind with no starter for it says so; an unknown kind is wrong usage', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cli-design-kind-none-')));
  try {
    git(['init', '-q', '--initial-branch=main'], root);
    const starter = { 'tokens.css': Buffer.from(':root{}\n') };
    await assert.rejects(
      runDesign(
        'init',
        [],
        { kind: 'poster' },
        terminal(root, coordinator().api, { starter: () => starter }).deps,
      ),
      (error) => error.exitCode === 2 && /No kind "poster"/.test(error.message),
    );
    const made = terminal(root, coordinator().api, { starter: () => starter });
    const result = await runDesign('init', [], { kind: 'slides' }, made.deps);
    assert.equal(result.exitCode, 0);
    assert.match(made.text(), /No starter for slides/);
    const canvas = JSON.parse(readFileSync(join(root, 'design/canvas.json'), 'utf8'));
    assert.deepEqual([canvas.kind, canvas.schemes], ['slides', ['light']]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('export prints each board at its own size in canvas order into one PDF', async () => {
  const { exportOrder, mergePdfs } = await import('./design-export.mjs');
  assert.deepEqual(
    exportOrder({ order: ['B.html', 'Z.html'], boards: { 'C.html': {}, 'A.html': {} } }, [
      'A.html',
      'B.html',
      'C.html',
      'D.html',
    ]),
    ['B.html', 'C.html', 'A.html', 'D.html'],
  );
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cli-design-export-')));
  try {
    git(['init', '-q', '--initial-branch=main'], root);
    mkdirSync(join(root, 'design/boards'), { recursive: true });
    writeFileSync(
      join(root, 'design/canvas.json'),
      JSON.stringify({ kind: 'slides', order: ['Two.html', 'One.html'], boards: {} }),
    );
    for (const [file, head] of [
      ['One.html', 'platform=slide'],
      ['Two.html', 'platform=print,size=85x55mm,bleed=3mm'],
      ['Notes.html', 'platform=doc,page=letter'],
      ['Mark.html', 'platform=logo'],
    ])
      writeFileSync(
        join(root, 'design/boards', file),
        `<meta name="design-board" content="${head}"><main>${file}</main>`,
      );
    const printed = [];
    const drawing = {
      pdf: async (input) => {
        printed.push([input.file, input.paperWidth, input.paperHeight, input.fixed, input.css]);
        return Buffer.from(`pdf:${input.file}`);
      },
      shoot: async (input) => ({
        marks: input.logo ? { svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' } : null,
      }),
    };
    const run = terminal(root, coordinator().api, {
      openLocalDrawing: async () => ({ drawing, close: async () => {} }),
    });
    // The stand-in PDFs have no pages; the joining is tested on Chromium's own output.
    const result = await runDesign('export', [], {}, run.deps);
    assert.deepEqual(result.json.boards, ['Two.html', 'One.html', 'Mark.html', 'Notes.html']);
    // A logo's mark leaves as SVG beside the PDF.
    assert.deepEqual(result.json.marks, ['output/design/Mark-mark.svg']);
    assert.match(readFileSync(join(root, 'output/design/Mark-mark.svg'), 'utf8'), /^<svg/);
    assert.ok(existsSync(join(root, 'output/design/export')));
    assert.deepEqual(
      printed.map(([file, w, h, fixed, css]) => [file, Math.round(w), Math.round(h), fixed, css]),
      [
        ['Two.html', 344, 231, true, undefined],
        ['One.html', 1920, 1080, true, undefined],
        ['Mark.html', 1024, 1024, true, undefined],
        ['Notes.html', 816, 1056, false, true],
      ],
      'canvas order, each at its own paper: trim plus bleed, the slide, a letter page',
    );
    await assert.rejects(
      runDesign('export', ['Nope'], {}, run.deps),
      (error) => error.exitCode === 2 && /No board named Nope\.html/.test(error.message),
    );
    assert.equal(typeof mergePdfs, 'function');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('init --kind with the real starter: only the kind, a starting board with true meta, no app components', async () => {
  const { designStarterFiles } = await import('./design-local-assets.mjs');
  const starter = designStarterFiles();
  const sizes = {
    doc: [700, 1975],
    slides: [1920, 1080],
    print: [344, 231],
    mac: [1280, 800],
    game: [390, 844],
    logo: [1024, 1024],
  };
  for (const [kind, [w, h]] of Object.entries(sizes)) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `cli-design-real-${kind}-`)));
    try {
      git(['init', '-q', '--initial-branch=main'], root);
      await runDesign(
        'init',
        ['proj'],
        { kind },
        terminal(root, coordinator().api, { starter: () => starter }).deps,
      );
      const ds = join(root, 'design/ds/proj');
      assert.equal(
        existsSync(join(ds, 'examples/ExampleList.html')),
        false,
        `${kind}: no app example`,
      );
      const library = JSON.parse(readFileSync(join(ds, 'library.json'), 'utf8'));
      assert.ok(library.components.length > 0, kind);
      assert.ok(
        library.components.every((component) => !['web', 'phone'].includes(component.platform)),
        `${kind}: no web or phone component in the guide`,
      );
      assert.doesNotMatch(readFileSync(join(ds, 'README.md'), 'utf8'), /iPhone conventions/, kind);
      assert.match(
        readFileSync(join(ds, 'README.md'), 'utf8'),
        /Invented figures|invented figures/i,
        kind,
      );
      const canvas = JSON.parse(readFileSync(join(root, 'design/canvas.json'), 'utf8'));
      const [file, place] = Object.entries(canvas.boards)[0];
      assert.deepEqual([place.w, place.h], [w, h], `${kind}: canvas size`);
      assert.deepEqual(canvas.order, [file]);
      const html = readFileSync(join(root, 'design/boards', file), 'utf8');
      assert.doesNotMatch(html, /__DS__/);
      assert.match(html, new RegExp(`platform=${kind === 'slides' ? 'slide' : kind}`));
      if (kind === 'game') assert.match(html, /width=390,height=844/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('the kind kits carry what the round-3 review asked for', async () => {
  const { designStarterFiles } = await import('./design-local-assets.mjs');
  const text = (path) => Buffer.from(designStarterFiles()[path]).toString('utf8');
  // Slides: figures and a closing slide that is more than one line.
  assert.match(text('kinds/slides/slides.css'), /\.ds-slide-figures/);
  assert.match(text('kinds/slides/slides.css'), /\.ds-slide\.closing/);
  assert.match(text('kinds/slides/slides.md'), /closing slide/i);
  const slides = JSON.parse(text('kinds/slides/library-slides.json')).components.map((c) => c.id);
  assert.ok(slides.includes('slide-figures') && slides.includes('slide-closing'));
  // Print: a ground is on the face, never on a child; a back fills its face.
  assert.match(text('kinds/print/examples/PostcardFront.html'), /ds-print-face ground-brand/);
  assert.doesNotMatch(text('kinds/print/examples/PostcardFront.html'), /ds-print-bleed ground/);
  assert.match(text('kinds/print/examples/PostcardBack.html'), /ds-print-back/);
  // Game: every example says its size; the status bar and home indicator are drawn.
  for (const name of ['GameTitle', 'GamePlay', 'GameLevels']) {
    const html = text(`kinds/game/examples/${name}.html`);
    assert.match(html, /width=390,height=844/, name);
    assert.match(html, /ds-game-status/, name);
    assert.match(html, /ds-game-home/, name);
  }
  // Mac: the pieces round 2 had to add, and the selection rule.
  const mac = text('kinds/mac/mac.css');
  for (const rule of [
    '.plain',
    '.ds-mac-search.wide',
    '.ds-mac-textarea',
    '.under-extra',
    '.has-popover',
    '.app-name',
    '.focused',
    '.inactive',
  ])
    assert.ok(mac.includes(rule), rule);
  assert.match(text('kinds/mac/mac.md'), /grey when its pane/);
  // Logo: a small cut and fixed-ground tiles.
  assert.match(text('kinds/logo/logo.css'), /\.s16 \.full/);
  assert.match(text('kinds/logo/examples/LogoLockups.html'), /data-theme="dark"/);
  // Every kind says no invented figures.
  for (const kind of ['doc', 'slides', 'print', 'mac', 'game', 'logo'])
    assert.match(text(`kinds/${kind}/${kind}.md`), /invented|made up/i, kind);
});

test('the review brief makes a critic list every unflagged invented figure as a fact', async () => {
  const { INIT_README, reviewBrief } = await import('./cli-design.mjs');
  const brief = reviewBrief({ top: '/p', boards: ['A.html'] });
  assert.match(brief, /unflagged one separately as a \[fact\] finding/);
  assert.match(INIT_README('p'), /No invented figures/);
  assert.match(INIT_README('p'), /1,840 kg/);
  const slides = INIT_README('p', 'slides');
  assert.doesNotMatch(slides, /iPhone is iPhone/);
  assert.match(slides, /No invented figures/);
});
