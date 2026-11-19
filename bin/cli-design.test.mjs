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
import { join } from 'node:path';
import {
  DESIGN_HELP,
  DESIGN_README,
  designSlug,
  projectFromRemote,
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
  assert.match(DESIGN_HELP, /^deploy design — change what people see, and get it approved first\n/);
  assert.match(DESIGN_HELP, /\n {2}dev {22}Open the Design page on this folder, as you save\n/);
  assert.match(DESIGN_HELP, /\n {2}capture <url> <Board> {4}Put the running app on a board\n/);
  assert.doesNotMatch(DESIGN_HELP, /guide/);
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
    assert.match(clean.text(), /No problems\. Ask for review with:\n {2}deploy design propose\n$/);
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
        'No problems. Commit the restored boards, then ask for review with:',
        '  deploy design propose',
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

test('capture puts the running app on a new board, and later only refreshes its pictures', async () => {
  const repo = repository();
  try {
    const requests = [];
    let clock = NOW;
    const png = (width) => Buffer.from(`png ${width}`);
    const run = terminal(repo.clone, coordinator().api, {
      now: () => clock,
      capture: async (url, widths, height) => {
        requests.push({ url, widths, height });
        clock += 3000;
        return widths.map(png);
      },
    });
    const result = await runDesign('capture', ['localhost:5173', 'Harbor'], {}, run.deps);
    assert.equal(result.exitCode, 0);
    assert.equal(
      run.text(),
      [
        '✓ Captured the running app         1440 · 700   3 s',
        '✓ Saved 2 pictures                 design/boards/captures/Harbor-1440.png',
        '✓ New board                        design/boards/Harbor.html',
        '',
        'Harbor shows the app as it runs. Draw the change over it.',
        '',
      ].join('\n'),
    );
    assert.deepEqual(requests, [
      { url: 'http://localhost:5173', widths: [1440, 700], height: 900 },
    ]);
    const design = join(repo.clone, 'design');
    assert.equal(readFileSync(join(design, 'boards/captures/Harbor-700.png'), 'utf8'), 'png 700');
    const board = readFileSync(join(design, 'boards/Harbor.html'), 'utf8');
    assert.match(board, /src="captures\/Harbor-1440\.png"/);
    assert.match(board, /srcset="captures\/Harbor-700\.png"/);
    assert.doesNotMatch(board, /<script/);
    const canvas = JSON.parse(readFileSync(join(design, 'canvas.json'), 'utf8'));
    assert.deepEqual(canvas.boards['Harbor.html'], {
      x: 1600,
      y: 0,
      w: 1440,
      h: 900,
      title: 'Harbor',
    });
    assert.deepEqual(canvas.order, ['Sidebar.html', 'Harbor.html']);

    // Again: the board is kept as drawn, only its pictures change.
    writeFileSync(join(design, 'boards/Harbor.html'), '<p data-layer="drawn">Drawn over</p>');
    const again = terminal(repo.clone, coordinator().api, {
      capture: async (_url, widths) => widths.map(() => Buffer.from('newer')),
    });
    await runDesign('capture', ['http://127.0.0.1:5173/trade', 'Harbor.html'], {}, again.deps);
    assert.doesNotMatch(again.text(), /New board/);
    assert.equal(
      readFileSync(join(design, 'boards/Harbor.html'), 'utf8'),
      '<p data-layer="drawn">Drawn over</p>',
    );
    assert.equal(readFileSync(join(design, 'boards/captures/Harbor-1440.png'), 'utf8'), 'newer');

    // A phone board is captured at its own width.
    const phone = JSON.parse(readFileSync(join(design, 'canvas.json'), 'utf8'));
    phone.boards['Dock.html'] = { x: 0, y: 1200, w: 390, h: 844, title: 'Dock' };
    writeFileSync(join(design, 'canvas.json'), JSON.stringify(phone));
    const widths = [];
    await runDesign(
      'capture',
      ['localhost:5173', 'Dock'],
      {},
      terminal(repo.clone, coordinator().api, {
        capture: async (_url, at, height) => (widths.push([at, height]), at.map(png)),
      }).deps,
    );
    assert.deepEqual(widths, [[[390], 844]]);
    assert.match(readFileSync(join(design, 'boards/Dock.html'), 'utf8'), /captures\/Dock-390\.png/);
  } finally {
    repo.cleanup();
  }
});

test('capture without Chromium says so and changes nothing', async () => {
  const repo = repository();
  try {
    const run = terminal(repo.clone, coordinator().api, { capture: async () => null });
    await assert.rejects(
      () => runDesign('capture', ['localhost:5173', 'Harbor'], {}, run.deps),
      (error) =>
        error.message === 'Chromium is not installed here, so the app was not captured.' &&
        error.next === 'deploy browser install' &&
        error.exitCode === 1,
    );
    assert.equal(run.text(), '');
    assert.equal(existsSync(join(repo.clone, 'design/boards/Harbor.html')), false);
    await assert.rejects(
      () => runDesign('capture', ['localhost:5173'], {}, run.deps),
      (error) => error.exitCode === 2,
    );
  } finally {
    repo.cleanup();
  }
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
