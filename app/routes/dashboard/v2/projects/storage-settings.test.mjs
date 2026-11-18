import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness, elements, uiStubs } from '../../../../../scripts/component-harness.mjs';

const text = (node) =>
  Array.isArray(node)
    ? node.map(text).join('')
    : node && typeof node === 'object'
      ? text(node.props?.children)
      : typeof node === 'boolean'
        ? ''
        : String(node ?? '');
const MB = 1024 * 1024;
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const summary = {
  available: true,
  measuredAt: minutesAgo(2),
  measuring: false,
  total: 1434 * MB,
  largeFiles: { bytes: 1126 * MB, count: 14 },
  history: { bytes: 212 * MB, commits: 2310, files: 4817 },
  work: { bytes: 86 * MB, tasks: 38, reviews: 4 },
  other: { bytes: 12 * MB },
};
async function section(data) {
  return componentHarness('app/routes/dashboard/v2/projects/storage-settings.client.tsx', {
    '@/components/ui': uiStubs,
    './data': { useData: (path) => (path ? data : { data: undefined }) },
    '../data/hooks': { useCoordinatorName: () => 'SER' },
  });
}

test('the Storage section shows the measured total, four rows, and opens the two lists', async () => {
  const h = await section({ data: summary, refresh() {} });
  const tree = h.render(h.exports.StorageSettings, { project: { id: 'home-gym' } });
  const words = text(tree);
  assert.match(words, /What this repository takes up on SER\. Backups and the apps' own data/);
  const group = elements(tree, 'Group')[0];
  assert.equal(group.props.title, '1.4 GB on SER');
  assert.equal(text(group.props.end), 'Measured 2 min ago');
  for (const line of [
    'Large files14 files stored with Git LFS',
    'Branches and tagsThe code and its history · 2,310 commits',
    'Tasks and reviewsWork deploy.local keeps for 38 tasks and 4 design reviews',
    'OtherIndexes, and objects waiting for cleanup',
  ])
    assert.ok(words.includes(line), line);
  for (const size of ['1.1 GB', '212 MB', '86 MB', '12 MB']) assert.ok(words.includes(size), size);
  const buttons = elements(tree, 'button');
  assert.deepEqual(
    buttons.map((button) => text(elements(button, 'span')[1])),
    ['Large files', 'Branches and tags'],
    'only the two rows with a list open one',
  );
  buttons[1].props.onClick();
  const opened = h.render(h.exports.StorageSettings, { project: { id: 'home-gym' } });
  const dialog = elements(opened, 'section')[0].props.children.at(-1);
  assert.equal(dialog.props.kind, 'history');
  assert.match(dialog.props.path, /\/api\/projects\/home-gym\/storage\/files\?kind=history&at=/);
  h.dispose();
});

test('before the first measurement the section shows loading rows and asks again', async () => {
  const h = await section({
    data: { available: true, measuredAt: null, measuring: true },
    refresh() {},
  });
  const tree = h.render(h.exports.StorageSettings, { project: { id: 'home-gym' } });
  assert.equal(elements(tree, 'Skeleton')[0].props.label, 'Measuring storage');
  assert.equal(elements(tree, 'Group').length, 0);
  h.dispose();
});

test('a failed first measurement says so with one thing to do', async () => {
  const h = await section({
    data: { available: true, measuredAt: null, measuring: false, error: 'Git command failed' },
    refresh() {},
  });
  const tree = h.render(h.exports.StorageSettings, { project: { id: 'home-gym' } });
  const banner = elements(tree, 'Banner')[0];
  assert.equal(banner.props.title, "Couldn't measure this repository");
  assert.equal(banner.props.kind, 'danger');
  assert.equal(elements(tree, 'Skeleton').length, 0);
  h.dispose();
});

test('a project without a hosted repository shows no Storage section', async () => {
  const h = await section({ data: { available: false }, refresh() {} });
  assert.equal(h.render(h.exports.StorageSettings, { project: { id: 'home-gym' } }), null);
  h.dispose();
});

/** A dialog whose reads are answered by `answer(path)`; every path asked for is kept. */
async function filesDialog(answer) {
  const asked = [];
  const timers = [];
  const h = await componentHarness(
    'app/routes/dashboard/v2/projects/storage-settings.client.tsx',
    {
      '@/components/ui': uiStubs,
      './data': {
        useData: (path) => {
          if (path) asked.push(path);
          return { data: path ? answer(path) : undefined, error: '', refresh() {} };
        },
      },
      '../data/hooks': { useCoordinatorName: () => 'SER' },
    },
    {
      setTimeout: (run, ms) => timers.push({ run, ms }),
      clearTimeout: () => {},
    },
  );
  return { h, asked, timers };
}
const params = (path) => Object.fromEntries(new URL(path, 'http://x').searchParams);
const lfsFiles = [
  {
    oid: 'a'.repeat(64),
    path: 'assets/video/onboarding.mp4',
    bytes: 412 * MB,
    addedAt: minutesAgo(30 * 1440),
    onBranch: true,
  },
  {
    oid: 'b'.repeat(64),
    path: 'assets/video/form-check-squat.mov',
    bytes: 286 * MB,
    addedAt: minutesAgo(70 * 1440),
    onBranch: true,
  },
  {
    oid: 'c'.repeat(64),
    path: 'assets/video/form-check-deadlift.mov',
    bytes: 88 * MB,
    addedAt: minutesAgo(220 * 1440),
    onBranch: false,
  },
];
/** What the server answers for the three-file list: it searches; the order is the test's. */
function lfsPage(path) {
  const { query = '', sort, direction, page } = params(path);
  const matched = lfsFiles.filter((file) => file.path.includes(query.toLowerCase()));
  return {
    kind: 'lfs',
    measuredAt: minutesAgo(2),
    count: 3,
    bytes: 786 * MB,
    query,
    sort,
    direction,
    page: Number(page),
    pageSize: 50,
    matches: matched.length,
    matchedBytes: matched.reduce((sum, file) => sum + file.bytes, 0),
    files: direction === 'ascending' && sort === 'size' ? [...matched].reverse() : matched,
  };
}
const names = (node) =>
  elements(node, 'tr')
    .slice(1)
    .map((tr) => text(elements(tr, 'span')[0]));
const props = {
  kind: 'lfs',
  path: '/api/projects/home-gym/storage/files?kind=lfs&at=1',
  onClose() {},
};

test('the Large files list asks the server for each sort and search', async () => {
  const { h, asked, timers } = await filesDialog(lfsPage);
  let tree = h.render(h.exports.StorageFilesDialog, props);
  assert.deepEqual(params(asked.at(-1)), {
    kind: 'lfs',
    at: '1',
    sort: 'size',
    direction: 'descending',
    page: '1',
  });
  const box = elements(tree, 'Dialog')[0];
  assert.equal(box.props.title, 'Large files');
  assert.equal(box.props.open, true);
  assert.match(text(tree), /3 files stored with Git LFS · 786 MB/);
  assert.match(text(tree), /A file that is not on any branch still takes space/);
  assert.equal(elements(tree, 'Action').length, 0, 'one page: no range and no buttons');
  assert.doesNotMatch(text(tree), /1–3 of 3/);
  let headers = elements(tree, 'th');
  assert.deepEqual(
    headers.map((th) => [text(th.props.children).trim(), th.props['aria-sort']]),
    [
      ['File', undefined],
      ['Added', undefined],
      ['Size', 'descending'],
    ],
  );
  assert.deepEqual(names(tree), [
    'assets/video/onboarding.mp4',
    'assets/video/form-check-squat.mov',
    'assets/video/form-check-deadlift.mov',
  ]);
  assert.equal(text(elements(tree, 'tr')[3]).includes('Not on any branch'), true);

  elements(headers[2], 'button')[0].props.onClick();
  tree = h.render(h.exports.StorageFilesDialog, props);
  assert.equal(params(asked.at(-1)).direction, 'ascending');
  assert.equal(elements(tree, 'th')[2].props['aria-sort'], 'ascending');
  assert.equal(names(tree)[0], 'assets/video/form-check-deadlift.mov');
  elements(elements(tree, 'th')[0], 'button')[0].props.onClick();
  tree = h.render(h.exports.StorageFilesDialog, props);
  headers = elements(tree, 'th');
  assert.equal(headers[0].props['aria-sort'], 'ascending');
  assert.equal(headers[2].props['aria-sort'], undefined);
  assert.equal(params(asked.at(-1)).sort, 'file');

  // Typing waits for a pause before it asks the server.
  elements(tree, 'input')[0].props.onChange({ target: { value: ' squat ' } });
  tree = h.render(h.exports.StorageFilesDialog, props);
  assert.equal(params(asked.at(-1)).query, undefined);
  h.effects();
  assert.equal(timers.at(-1).ms, 200);
  timers.at(-1).run();
  tree = h.render(h.exports.StorageFilesDialog, props);
  assert.deepEqual(params(asked.at(-1)), {
    kind: 'lfs',
    at: '1',
    sort: 'file',
    direction: 'ascending',
    page: '1',
    query: 'squat',
  });
  assert.match(text(tree), /1 of 3 files · 286 MB/);
  assert.deepEqual(names(tree), ['assets/video/form-check-squat.mov']);

  elements(tree, 'input')[0].props.onChange({ target: { value: 'backup' } });
  h.render(h.exports.StorageFilesDialog, props);
  h.effects();
  timers.at(-1).run();
  tree = h.render(h.exports.StorageFilesDialog, props);
  assert.match(text(tree), /0 of 3 files/);
  assert.equal(elements(tree, 'table').length, 0);
  assert.match(text(tree), /No files match “backup”Search looks at file paths\./);

  // Closing and opening again starts over: no search, size descending, page 1.
  h.render(h.exports.StorageFilesDialog, { ...props, kind: null, path: undefined });
  h.render(h.exports.StorageFilesDialog, props);
  assert.deepEqual(params(asked.at(-1)), {
    kind: 'lfs',
    at: '1',
    sort: 'size',
    direction: 'descending',
    page: '1',
  });
  h.dispose();
});

const historyFile = (n) => ({
  path: `src/file-${n}.ts`,
  bytes: (5000 - n) * 1024,
  versions: 2,
  lastChangedAt: minutesAgo(1440),
  deleted: false,
});
/** 4,817 files, 50 to a page; a page not answered yet is still loading. */
function historyPages(loaded) {
  return (path) => {
    const { page, query = '' } = params(path);
    if (!loaded.has(`${page} ${query}`)) return undefined;
    const matches = query ? 120 : 4817;
    const start = (Number(page) - 1) * 50;
    return {
      kind: 'history',
      measuredAt: minutesAgo(2),
      count: 4817,
      commits: 2310,
      bytes: 212 * MB,
      query,
      sort: 'size',
      direction: 'descending',
      page: Number(page),
      pageSize: 50,
      matches,
      matchedBytes: query ? 3 * MB : 212 * MB,
      files: Array.from({ length: Math.min(50, matches - start) }, (_, i) =>
        historyFile(start + i),
      ),
    };
  };
}

test('a long list pages with Previous and Next and keeps its rows while the next page loads', async () => {
  const loaded = new Set(['1 ']);
  const { h, asked, timers } = await filesDialog(historyPages(loaded));
  const history = { ...props, kind: 'history', path: props.path.replace('lfs', 'history') };
  let tree = h.render(h.exports.StorageFilesDialog, history);
  assert.match(text(tree), /4,817 files in 2,310 commits · 212 MB/);
  const pager = () =>
    elements(tree, 'div').find((div) => div.props.className === 'v2-storage-pages');
  assert.equal(text(elements(pager(), 'span')[0]), '1–50 of 4,817');
  assert.equal(elements(pager(), 'span')[0].props.className, 'dl-meta');
  let [previous, next] = elements(tree, 'Action');
  assert.deepEqual(
    [
      text(previous.props.children),
      previous.props.disabled,
      text(next.props.children),
      next.props.disabled,
    ],
    ['Previous', true, 'Next', false],
  );
  assert.equal(names(tree).length, 50);

  // Page 2 is asked for; until it comes, page 1's rows stay, with no loading rows.
  next.props.onClick();
  tree = h.render(h.exports.StorageFilesDialog, history);
  assert.equal(params(asked.at(-1)).page, '2');
  assert.equal(elements(tree, 'Skeleton').length, 0);
  assert.equal(names(tree)[0], 'src/file-0.ts');
  loaded.add('2 ');
  tree = h.render(h.exports.StorageFilesDialog, history);
  assert.equal(names(tree)[0], 'src/file-50.ts');
  assert.equal(text(elements(pager(), 'span')[0]), '51–100 of 4,817');
  [previous, next] = elements(tree, 'Action');
  assert.equal(previous.props.disabled, false);

  // A search returns to page 1 and counts its matches.
  elements(tree, 'input')[0].props.onChange({ target: { value: 'file' } });
  h.render(h.exports.StorageFilesDialog, history);
  h.effects();
  timers.at(-1).run();
  loaded.add('1 file').add('3 file');
  tree = h.render(h.exports.StorageFilesDialog, history);
  assert.deepEqual([params(asked.at(-1)).page, params(asked.at(-1)).query], ['1', 'file']);
  assert.match(text(tree), /120 of 4,817 files · 3 MB/);
  assert.equal(text(elements(pager(), 'span')[0]), '1–50 of 120');
  // Next counts from the page shown: pressed again before page 2 comes, it still asks for 2.
  elements(tree, 'Action')[1].props.onClick();
  tree = h.render(h.exports.StorageFilesDialog, history);
  elements(tree, 'Action')[1].props.onClick();
  tree = h.render(h.exports.StorageFilesDialog, history);
  assert.equal(params(asked.at(-1)).page, '2');
  loaded.add('2 file');
  tree = h.render(h.exports.StorageFilesDialog, history);
  assert.equal(text(elements(pager(), 'span')[0]), '51–100 of 120');
  elements(tree, 'Action')[1].props.onClick();
  tree = h.render(h.exports.StorageFilesDialog, history);
  assert.equal(text(elements(pager(), 'span')[0]), '101–120 of 120');
  [previous, next] = elements(tree, 'Action');
  assert.deepEqual([previous.props.disabled, next.props.disabled], [false, true]);
  assert.equal(names(tree).length, 20);
  h.dispose();
});

test('the first page loads with loading rows', async () => {
  const { h } = await filesDialog(() => undefined);
  const tree = h.render(h.exports.StorageFilesDialog, props);
  assert.equal(elements(tree, 'Skeleton')[0].props.label, 'Loading files');
  assert.equal(elements(tree, 'table').length, 0);
  h.dispose();
});

test('the Branches and tags list has versions, last changed and deleted files', async () => {
  const history = {
    kind: 'history',
    measuredAt: minutesAgo(2),
    count: 4817,
    commits: 2310,
    bytes: 212 * MB,
    query: '',
    sort: 'size',
    direction: 'descending',
    page: 1,
    pageSize: 50,
    matches: 2,
    matchedBytes: 52 * MB,
    files: [
      {
        path: 'package-lock.json',
        bytes: 38 * MB,
        versions: 184,
        lastChangedAt: minutesAgo(1440),
        deleted: false,
      },
      {
        path: 'dist/bundle.js',
        bytes: 14 * MB,
        versions: 9,
        lastChangedAt: minutesAgo(400 * 1440),
        deleted: true,
      },
    ],
  };
  const h = await section({ data: history, refresh() {} });
  const tree = h.render(h.exports.StorageFilesDialog, {
    kind: 'history',
    path: '/api/projects/home-gym/storage/files?kind=history',
    onClose() {},
  });
  assert.equal(elements(tree, 'Dialog')[0].props.title, 'Branches and tags');
  assert.match(text(tree), /4,817 files in 2,310 commits · 212 MB/);
  assert.deepEqual(
    elements(tree, 'th').map((th) => text(th.props.children).trim()),
    ['File', 'Versions', 'Last changed', 'Size'],
  );
  const rows = elements(tree, 'tr')
    .slice(1)
    .map((tr) => text(tr));
  assert.deepEqual(rows, [
    'package-lock.json184Yesterday38 MB',
    'dist/bundle.jsDeleted9A year ago14 MB',
  ]);
  assert.match(text(tree), /A deleted file still takes space while an earlier commit holds it/);
  h.dispose();
});
