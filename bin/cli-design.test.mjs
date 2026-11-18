import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { designSlug, projectFromRemote, runDesign, titleFromBranch } from './cli-design.mjs';

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();

/** An origin with main, and a clone of it named deploy.local, both in a fresh folder. */
function repository() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cli-design-')));
  const origin = join(root, 'origin.git');
  git(['init', '--bare', '--initial-branch=main', origin], root);
  const seed = join(root, 'seed');
  git(['init', '--initial-branch=main', seed], root);
  git(['config', 'user.name', 'Test'], seed);
  git(['config', 'user.email', 'test@example.invalid'], seed);
  mkdirSync(join(seed, 'design/boards'), { recursive: true });
  writeFileSync(join(seed, 'design/boards/Sidebar.html'), '<p data-layer="name">Name</p>');
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
      runCheck: async () => null,
      ...extra,
    },
    text: () => text,
  };
}

const checked = (problems = []) => ({
  code: problems.length ? 1 : 0,
  stdout: `${JSON.stringify({
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
  })}\n`,
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
        `✓ Fetched main                     ${commit} · just now`,
        '✓ Branch                           design/sidebar-by-project',
        '✓ Folder                           ../deploy.local-sidebar-by-project',
        '',
        'Sidebar by project is yours on MacBook Pro.',
        'It shows on the Design page as being worked on.',
        '',
        'Edit the boards in design/boards, then:',
        '  cd ../deploy.local-sidebar-by-project',
        '  deploy design check',
        '',
      ].join('\n'),
    );
    const folder = join(repo.root, 'deploy.local-sidebar-by-project');
    assert.equal(git(['branch', '--show-current'], folder), 'design/sidebar-by-project');
    assert.deepEqual(server.calls, [
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

test('check prints each step, what changed per board and the problems, and exits 1 on one', async () => {
  const repo = repository();
  try {
    const run = terminal(repo.clone, coordinator().api, { runCheck: async () => checked(cutOff) });
    const result = await runDesign('check', [], {}, run.deps);
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
    const clean = terminal(repo.clone, coordinator().api, { runCheck: async () => checked() });
    assert.equal((await runDesign('check', [], {}, clean.deps)).exitCode, 0);
    assert.match(clean.text(), /No problems\. Ask for review with:\n {2}deploy design propose\n$/);
    const none = terminal(repo.clone, coordinator().api);
    assert.equal((await runDesign('check', [], {}, none.deps)).exitCode, 0);
    assert.match(none.text(), /^This project has no design check \(scripts\/design-check\.mjs\)/);
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
    const bad = terminal(folder, refused.api, { runCheck: async () => checked(cutOff) });
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
    const run = terminal(folder, server.api, { runCheck: async () => checked() });
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
      () => runDesign('propose', [], flags, terminal(folder, coordinator().api).deps),
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
    const json = terminal(repo.clone, coordinator().api, {
      runCheck: async () => checked(cutOff),
      color: true,
    });
    const result = await runDesign('check', [], { json: true }, json.deps);
    assert.equal(json.text(), '');
    assert.equal(result.exitCode, 1);
    assert.equal(result.json.problems[0].label, 'Projects is cut off at 700 px');
    const coloured = terminal(repo.clone, coordinator().api, {
      runCheck: async () => checked(cutOff),
      color: true,
    });
    await runDesign('check', [], {}, coloured.deps);
    const escape = String.fromCharCode(27);
    assert.ok(coloured.text().includes(`${escape}[31m✗${escape}[0m Projects`));
    const plain = terminal(repo.clone, coordinator().api, {
      runCheck: async () => checked(cutOff),
    });
    await runDesign('check', [], {}, plain.deps);
    assert.ok(!plain.text().includes(escape));
    await assert.rejects(
      () => runDesign('nope', [], {}, plain.deps),
      (error) => error.exitCode === 2 && /Unknown design command/.test(error.message),
    );
  } finally {
    repo.cleanup();
  }
});
