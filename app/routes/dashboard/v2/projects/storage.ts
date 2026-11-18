// Words and numbers for a project's Storage section and its two file lists.

export type StorageSummary =
  | { available: false }
  | {
      available: true;
      measuredAt: string | null;
      measuring: boolean;
      error?: string;
      total?: number;
      largeFiles?: { bytes: number; count: number };
      history?: { bytes: number; commits: number; files: number };
      work?: { bytes: number; tasks: number; reviews: number };
      other?: { bytes: number };
    };
export type LargeFile = {
  oid: string;
  path: string | null;
  bytes: number;
  addedAt: string | null;
  onBranch: boolean;
};
export type HistoryFile = {
  path: string;
  bytes: number;
  versions: number;
  lastChangedAt: string | null;
  deleted: boolean;
};
export type StorageFiles =
  | {
      kind: 'lfs';
      measuredAt: string;
      count: number;
      bytes: number;
      files: LargeFile[];
      truncated: boolean;
    }
  | {
      kind: 'history';
      measuredAt: string;
      count: number;
      commits: number;
      bytes: number;
      files: HistoryFile[];
      truncated: boolean;
    };
export type SortKey = 'file' | 'added' | 'versions' | 'changed' | 'size';
export type Sort = { key: SortKey; direction: 'ascending' | 'descending' };
export type Row = {
  key: string;
  name: string;
  bytes: number;
  /** Added (large files) or last changed (history). */
  at: string | null;
  versions?: number;
  tag?: 'Not on any branch' | 'Deleted';
};

const units = ['B', 'KB', 'MB', 'GB', 'TB'];
/** 412 MB, 1.1 GB, 9 MB: whole numbers up to megabytes, one decimal from gigabytes under 10. */
export function formatBytes(bytes: number) {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (unit < units.length - 1 && Math.round(value) >= 1024) {
    value /= 1024;
    unit++;
  }
  const text = unit >= 3 && value < 9.95 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value);
  return `${text} ${units[unit]}`;
}

/** Today, Yesterday, 4 days ago, 3 weeks ago, 2 months ago, A year ago. */
export function ageLabel(value: string | null | undefined, now = Date.now()) {
  const time = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return 'Unavailable';
  const date = new Date(time),
    today = new Date(now);
  if (date.toDateString() === today.toDateString() || time > now) return 'Today';
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  const days = Math.max(2, Math.floor((now - time) / 86400000));
  const ago = (count: number, unit: string) =>
    count === 1 ? `A ${unit} ago` : `${count} ${unit}s ago`;
  if (days < 7) return `${days} days ago`;
  if (days < 30) return ago(Math.floor(days / 7), 'week');
  if (days < 365) return ago(Math.max(1, Math.floor(days / 30)), 'month');
  return ago(Math.floor(days / 365), 'year');
}

const count = (value: number, one: string, many: string, format: (n: number) => string) =>
  `${format(value)} ${value === 1 ? one : many}`;
const plain = (value: number) => value.toLocaleString('en-US');

export function largeFilesLine(files: number, format = plain) {
  return files === 0
    ? 'No files stored with Git LFS'
    : `${count(files, 'file', 'files', format)} stored with Git LFS`;
}
export function historyLine(commits: number, format = plain) {
  return `The code and its history · ${count(commits, 'commit', 'commits', format)}`;
}
export function workLine(tasks: number, reviews: number, format = plain) {
  const parts = [
    tasks ? count(tasks, 'task', 'tasks', format) : '',
    reviews ? count(reviews, 'design review', 'design reviews', format) : '',
  ].filter(Boolean);
  return `Work deploy.local keeps for ${parts.length ? parts.join(' and ') : 'tasks and reviews'}`;
}
/** A bar's share of the whole, in percent. Anything at all stays visible. */
export function share(bytes: number, total: number) {
  if (!total || bytes <= 0) return 0;
  return Math.min(100, Math.max(1, Math.round((bytes / total) * 100)));
}

/** One list's rows, named and tagged the way the dialog shows them. */
export function rows(data: StorageFiles): Row[] {
  return data.kind === 'lfs'
    ? data.files.map((file) => ({
        key: file.oid,
        // An object no pointer names is listed by the start of its id.
        name: file.path ?? file.oid.slice(0, 12),
        bytes: file.bytes,
        at: file.addedAt,
        ...(file.onBranch ? {} : { tag: 'Not on any branch' as const }),
      }))
    : data.files.map((file) => ({
        key: file.path,
        name: file.path,
        bytes: file.bytes,
        at: file.lastChangedAt,
        versions: file.versions,
        ...(file.deleted ? { tag: 'Deleted' as const } : {}),
      }));
}
/** Search looks at file paths, ignoring case. */
export function filterRows(list: Row[], query: string) {
  const needle = query.trim().toLowerCase();
  return needle ? list.filter((row) => row.name.toLowerCase().includes(needle)) : list;
}
const time = (row: Row) => (row.at ? Date.parse(row.at) || 0 : 0);
export function sortRows(list: Row[], sort: Sort) {
  const sign = sort.direction === 'ascending' ? 1 : -1;
  const value = (row: Row): number | string =>
    sort.key === 'file'
      ? row.name.toLowerCase()
      : sort.key === 'size'
        ? row.bytes
        : sort.key === 'versions'
          ? (row.versions ?? 0)
          : time(row);
  return [...list].sort((a, b) => {
    const x = value(a),
      y = value(b);
    const order = x < y ? -1 : x > y ? 1 : 0;
    return order * sign || a.name.localeCompare(b.name);
  });
}
/** A header click: the same column turns around; a new one starts where it reads best. */
export function nextSort(current: Sort, key: SortKey): Sort {
  if (current.key === key)
    return { key, direction: current.direction === 'ascending' ? 'descending' : 'ascending' };
  return { key, direction: key === 'file' ? 'ascending' : 'descending' };
}
export const defaultSort: Sort = { key: 'size', direction: 'descending' };

/** The line above the table: the whole list, or how much of it the search matched. */
export function listLine(data: StorageFiles, query: string, matches: Row[], format = plain) {
  if (query.trim()) {
    const of = `${format(matches.length)} of ${count(data.count, 'file', 'files', format)}`;
    return matches.length
      ? `${of} · ${formatBytes(matches.reduce((sum, row) => sum + row.bytes, 0))}`
      : of;
  }
  return data.kind === 'lfs'
    ? `${largeFilesLine(data.count, format)} · ${formatBytes(data.bytes)}`
    : `${count(data.count, 'file', 'files', format)} in ${count(data.commits, 'commit', 'commits', format)} · ${formatBytes(data.bytes)}`;
}
