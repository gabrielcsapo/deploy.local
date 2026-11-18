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

const lfs = {
  kind: 'lfs',
  measuredAt: minutesAgo(2),
  count: 3,
  bytes: 786 * MB,
  truncated: false,
  files: [
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
  ],
};
test('the Large files list searches paths, sorts by header and says when nothing matches', async () => {
  const h = await section({ data: lfs, refresh() {} });
  const props = {
    kind: 'lfs',
    path: '/api/projects/home-gym/storage/files?kind=lfs',
    onClose() {},
  };
  let tree = h.render(h.exports.StorageFilesDialog, props);
  const dialog = elements(tree, 'Dialog')[0];
  assert.equal(dialog.props.title, 'Large files');
  assert.equal(dialog.props.open, true);
  assert.match(text(tree), /3 files stored with Git LFS · 786 MB/);
  assert.match(text(tree), /A file that is not on any branch still takes space/);
  let headers = elements(tree, 'th');
  assert.deepEqual(
    headers.map((th) => [text(th.props.children).trim(), th.props['aria-sort']]),
    [
      ['File', undefined],
      ['Added', undefined],
      ['Size', 'descending'],
    ],
  );
  const names = (node) =>
    elements(node, 'tr')
      .slice(1)
      .map((tr) => text(elements(tr, 'span')[0]));
  assert.deepEqual(names(tree), [
    'assets/video/onboarding.mp4',
    'assets/video/form-check-squat.mov',
    'assets/video/form-check-deadlift.mov',
  ]);
  assert.equal(text(elements(tree, 'tr')[3]).includes('Not on any branch'), true);

  elements(headers[2], 'button')[0].props.onClick();
  tree = h.render(h.exports.StorageFilesDialog, props);
  assert.equal(elements(tree, 'th')[2].props['aria-sort'], 'ascending');
  assert.equal(names(tree)[0], 'assets/video/form-check-deadlift.mov');
  elements(elements(tree, 'th')[0], 'button')[0].props.onClick();
  tree = h.render(h.exports.StorageFilesDialog, props);
  headers = elements(tree, 'th');
  assert.equal(headers[0].props['aria-sort'], 'ascending');
  assert.equal(headers[2].props['aria-sort'], undefined);

  elements(tree, 'input')[0].props.onChange({ target: { value: 'squat' } });
  tree = h.render(h.exports.StorageFilesDialog, props);
  assert.match(text(tree), /1 of 3 files · 286 MB/);
  assert.deepEqual(names(tree), ['assets/video/form-check-squat.mov']);

  elements(tree, 'input')[0].props.onChange({ target: { value: 'backup' } });
  tree = h.render(h.exports.StorageFilesDialog, props);
  assert.match(text(tree), /0 of 3 files/);
  assert.equal(elements(tree, 'table').length, 0);
  assert.match(text(tree), /No files match “backup”Search looks at file paths\./);
  h.dispose();
});

test('the Branches and tags list has versions, last changed and deleted files', async () => {
  const history = {
    kind: 'history',
    measuredAt: minutesAgo(2),
    count: 4817,
    commits: 2310,
    bytes: 212 * MB,
    truncated: true,
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
