import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ageLabel,
  defaultSort,
  filterRows,
  formatBytes,
  historyLine,
  largeFilesLine,
  listLine,
  nextSort,
  rows,
  share,
  sortRows,
  workLine,
  type StorageFiles,
} from './storage.ts';

const MB = 1024 * 1024;
test('sizes read like the board: whole megabytes, one decimal for small gigabytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(900), '900 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(212 * MB + 300_000), '212 MB');
  assert.equal(formatBytes(9.4 * MB), '9 MB');
  assert.equal(formatBytes(1.1 * 1024 * MB), '1.1 GB');
  assert.equal(formatBytes(1.4 * 1024 * MB), '1.4 GB');
  assert.equal(formatBytes(1024 * MB), '1 GB');
  assert.equal(formatBytes(1023.8 * MB), '1 GB', 'rounding up moves to the next unit');
  assert.equal(formatBytes(12.4 * 1024 * MB), '12 GB');
});

test('ages say Today, Yesterday, days, weeks, months and years', () => {
  const now = new Date(2026, 10, 18, 15, 0).getTime();
  const ago = (days: number, hours = 0) =>
    new Date(now - days * 86400000 - hours * 3600000).toISOString();
  assert.equal(ageLabel(ago(0, 2), now), 'Today');
  assert.equal(ageLabel(ago(1), now), 'Yesterday');
  assert.equal(ageLabel(ago(4), now), '4 days ago');
  assert.equal(ageLabel(ago(8), now), 'A week ago');
  assert.equal(ageLabel(ago(21), now), '3 weeks ago');
  assert.equal(ageLabel(ago(62), now), '2 months ago');
  assert.equal(ageLabel(ago(400), now), 'A year ago');
  assert.equal(ageLabel(ago(800), now), '2 years ago');
  assert.equal(ageLabel(null, now), 'Unavailable');
});

test('row descriptions count what was measured', () => {
  assert.equal(largeFilesLine(14), '14 files stored with Git LFS');
  assert.equal(largeFilesLine(1), '1 file stored with Git LFS');
  assert.equal(largeFilesLine(0), 'No files stored with Git LFS');
  assert.equal(historyLine(2310), 'The code and its history · 2,310 commits');
  assert.equal(historyLine(1), 'The code and its history · 1 commit');
  assert.equal(workLine(38, 4), 'Work deploy.local keeps for 38 tasks and 4 design reviews');
  assert.equal(workLine(1, 0), 'Work deploy.local keeps for 1 task');
  assert.equal(workLine(0, 1), 'Work deploy.local keeps for 1 design review');
  assert.equal(workLine(0, 0), 'Work deploy.local keeps for tasks and reviews');
  assert.equal(share(0, 100), 0);
  assert.equal(share(1, 1000), 1, 'anything at all stays visible');
  assert.equal(share(78, 100), 78);
});

const lfs: StorageFiles = {
  kind: 'lfs',
  measuredAt: '2026-11-18T12:00:00Z',
  count: 4,
  bytes: 412 * MB + 286 * MB + 88 * MB + 4 * MB,
  truncated: false,
  files: [
    {
      oid: 'a'.repeat(64),
      path: 'assets/video/onboarding.mp4',
      bytes: 412 * MB,
      addedAt: '2026-10-28T12:00:00Z',
      onBranch: true,
    },
    {
      oid: 'b'.repeat(64),
      path: 'assets/video/form-check-squat.mov',
      bytes: 286 * MB,
      addedAt: '2026-09-18T12:00:00Z',
      onBranch: true,
    },
    {
      oid: 'c'.repeat(64),
      path: 'assets/video/form-check-deadlift.mov',
      bytes: 88 * MB,
      addedAt: '2026-04-18T12:00:00Z',
      onBranch: false,
    },
    {
      oid: 'd'.repeat(64),
      path: null,
      bytes: 4 * MB,
      addedAt: '2025-01-01T12:00:00Z',
      onBranch: false,
    },
  ],
};

test('large files: tags, names, search and the line that follows it', () => {
  const list = rows(lfs);
  assert.equal(list[2].tag, 'Not on any branch');
  assert.equal(list[0].tag, undefined);
  assert.equal(list[3].name, 'dddddddddddd', 'an object no pointer names shows its id');
  assert.equal(listLine(lfs, '', list), '4 files stored with Git LFS · 790 MB');
  const video = filterRows(list, 'VIDEO');
  assert.equal(video.length, 3);
  assert.equal(listLine(lfs, 'video', video), '3 of 4 files · 786 MB');
  const none = filterRows(list, 'backup');
  assert.equal(none.length, 0);
  assert.equal(listLine(lfs, 'backup', none), '0 of 4 files');
  assert.equal(filterRows(list, '   ').length, 4, 'blank search shows everything');
});

test('sorting: size descending first, a header turns around, a new header starts sensibly', () => {
  const list = rows(lfs);
  assert.deepEqual(
    sortRows(list, defaultSort).map((row) => row.bytes),
    [412, 286, 88, 4].map((n) => n * MB),
  );
  assert.deepEqual(nextSort(defaultSort, 'size'), { key: 'size', direction: 'ascending' });
  assert.deepEqual(nextSort(defaultSort, 'file'), { key: 'file', direction: 'ascending' });
  assert.deepEqual(nextSort(defaultSort, 'added'), { key: 'added', direction: 'descending' });
  assert.deepEqual(
    sortRows(list, { key: 'file', direction: 'ascending' }).map((row) => row.name),
    [
      'assets/video/form-check-deadlift.mov',
      'assets/video/form-check-squat.mov',
      'assets/video/onboarding.mp4',
      'dddddddddddd',
    ],
  );
  assert.deepEqual(
    sortRows(list, { key: 'added', direction: 'descending' }).map((row) => row.bytes / MB),
    [412, 286, 88, 4],
  );
});

test('history: versions, deleted tags and its own header line', () => {
  const history: StorageFiles = {
    kind: 'history',
    measuredAt: '2026-11-18T12:00:00Z',
    count: 4817,
    commits: 2310,
    bytes: 212 * MB,
    truncated: true,
    files: [
      {
        path: 'package-lock.json',
        bytes: 38 * MB,
        versions: 184,
        lastChangedAt: null,
        deleted: false,
      },
      { path: 'dist/bundle.js', bytes: 14 * MB, versions: 9, lastChangedAt: null, deleted: true },
    ],
  };
  const list = rows(history);
  assert.equal(list[1].tag, 'Deleted');
  assert.equal(list[0].versions, 184);
  assert.equal(listLine(history, '', list), '4,817 files in 2,310 commits · 212 MB');
  assert.deepEqual(
    sortRows(list, { key: 'versions', direction: 'ascending' }).map((row) => row.name),
    ['dist/bundle.js', 'package-lock.json'],
  );
});
