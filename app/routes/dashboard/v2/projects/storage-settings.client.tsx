'use client';
import { useEffect, useState } from 'react';
import { Action, Banner, Dialog, Group, Icon, Skeleton } from '@/components/ui';
import type { Project } from '../../../../../shared/v2/contracts';
import { useCoordinatorName } from '../data/hooks';
import { useData } from './data';
import { useProjectFormatting } from './formatting.ts';
import { projectSegment } from './routing';
import {
  ageLabel,
  defaultSort,
  formatBytes,
  historyLine,
  largeFilesLine,
  listLine,
  nextSort,
  pageRange,
  rows,
  share,
  workLine,
  type Sort,
  type SortKey,
  type StorageFiles,
  type StorageSummary,
} from './storage.ts';
import './storage.css';

type Kind = 'lfs' | 'history';
// "Just now" and "Yesterday" start a sentence; after "Measured" they are lowercase.
const midSentence = (time: string) =>
  /^(Just now|Yesterday|Today)/.test(time) ? time[0].toLowerCase() + time.slice(1) : time;

/** What the project's hosted repository takes up on the coordinator, and what it is made of. */
export function StorageSettings({ project }: { project: Project }) {
  const { formatTime, formatCount } = useProjectFormatting();
  const coordinator = useCoordinatorName();
  const base = `/api/projects/${projectSegment(project.id)}/storage`;
  const storage = useData<StorageSummary>(base);
  const [open, setOpen] = useState<Kind | null>(null);
  const data = storage.data;
  const measuring = !!data && data.available && data.measuring;
  useEffect(() => {
    if (!measuring) return;
    const timer = setInterval(storage.refresh, 2000);
    return () => clearInterval(timer);
  }, [measuring, storage.refresh]);
  if (data && !data.available) return null;
  const measured = data?.available && data.measuredAt && data.total !== undefined ? data : null;
  const total = measured?.total ?? 0;
  const row = (label: string, description: string, bytes: number, kind?: Kind) => {
    const content = (
      <>
        <span className="dl-t">
          <span>{label}</span>
          <span>{description}</span>
        </span>
        <span className="dl-v">
          <span className="dl-bar v2-storage-bar" aria-hidden="true">
            <span style={{ width: `${share(bytes, total)}%` }} />
          </span>
          <span className="v2-storage-size">{formatBytes(bytes)}</span>
          {kind ? (
            <Icon name="chevron" size={14} className="dl-chev" />
          ) : (
            <span className="v2-storage-chev-space" />
          )}
        </span>
      </>
    );
    return kind ? (
      <button
        key={label}
        type="button"
        className="dl-setting v2-storage-row"
        onClick={() => setOpen(kind)}
      >
        {content}
      </button>
    ) : (
      <div key={label} className="dl-setting">
        {content}
      </div>
    );
  };
  return (
    <section className="dl-section">
      <h2 className="dl-section-title">Storage</h2>
      <p className="dl-section-sub">
        What this repository takes up on {coordinator}. Backups and the apps' own data are counted
        in Backups.
      </p>
      {storage.error && !data && (
        <Banner
          kind="danger"
          title="Couldn't load storage"
          action={<Action onClick={storage.refresh}>Try again</Action>}
        />
      )}
      {data?.available && data.error && !measuring && (
        <Banner
          kind={measured ? 'warning' : 'danger'}
          title="Couldn't measure this repository"
          action={<Action onClick={storage.refresh}>Try again</Action>}
        >
          {measured ? 'Showing the last measurement.' : undefined}
        </Banner>
      )}
      {measured ? (
        <Group
          className="v2-storage-group"
          title={`${formatBytes(total)} on ${coordinator}`}
          end={<span>Measured {midSentence(formatTime(measured.measuredAt!))}</span>}
        >
          {row(
            'Large files',
            largeFilesLine(measured.largeFiles!.count, formatCount),
            measured.largeFiles!.bytes,
            measured.largeFiles!.count ? 'lfs' : undefined,
          )}
          {row(
            'Branches and tags',
            historyLine(measured.history!.commits, formatCount),
            measured.history!.bytes,
            measured.history!.files ? 'history' : undefined,
          )}
          {row(
            'Tasks and reviews',
            workLine(measured.work!.tasks, measured.work!.reviews, formatCount),
            measured.work!.bytes,
          )}
          {row('Other', 'Indexes, and objects waiting for cleanup', measured.other!.bytes)}
        </Group>
      ) : (
        !(data?.available && data.error && !measuring) &&
        !(storage.error && !data) && (
          <Skeleton rows={4} label={data ? 'Measuring storage' : 'Loading'} />
        )
      )}
      {measured && (
        <StorageFilesDialog
          kind={open}
          onClose={() => setOpen(null)}
          path={open ? `${base}/files?kind=${open}&at=${measured.measuredAt}` : undefined}
        />
      )}
    </section>
  );
}

const titles: Record<Kind, string> = { lfs: 'Large files', history: 'Branches and tags' };
const footnotes: Record<Kind, string> = {
  lfs: 'A file that is not on any branch still takes space until it is removed from the repository.',
  history:
    "A deleted file still takes space while an earlier commit holds it. Size is what all of a file's versions take on disk after compression.",
};
const columns: Record<Kind, { key: SortKey; label: string; number?: boolean; wide?: boolean }[]> = {
  lfs: [
    { key: 'file', label: 'File', wide: true },
    { key: 'added', label: 'Added' },
    { key: 'size', label: 'Size', number: true },
  ],
  history: [
    { key: 'file', label: 'File', wide: true },
    { key: 'versions', label: 'Versions', number: true },
    { key: 'changed', label: 'Last changed' },
    { key: 'size', label: 'Size', number: true },
  ],
};

/** The files behind a Storage row, 50 at a time: the server searches, sorts and pages them. */
export function StorageFilesDialog({
  kind,
  path,
  onClose,
}: {
  kind: Kind | null;
  path: string | undefined;
  onClose: () => void;
}) {
  const { now, formatTime, formatCount } = useProjectFormatting();
  const [query, setQuery] = useState('');
  // What the server is asked to search for: the field, once typing pauses.
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>(defaultSort);
  const [page, setPage] = useState(1);
  const [shown, setShown] = useState<Kind | null>(kind);
  const files = useData<StorageFiles>(
    path &&
      `${path}&sort=${sort.key}&direction=${sort.direction}&page=${page}` +
        (search ? `&query=${encodeURIComponent(search)}` : ''),
  );
  // While the next page, sort or search loads, the rows shown stay in place.
  const [kept, setKept] = useState(files.data);
  if (files.data && files.data !== kept) setKept(files.data);
  // Each opening starts with an empty search, sorted by size, on the first page.
  if (kind !== shown) {
    setShown(kind);
    setQuery('');
    setSearch('');
    setSort(defaultSort);
    setPage(1);
    setKept(undefined);
  }
  useEffect(() => {
    const next = query.trim();
    if (next === search) return;
    const timer = setTimeout(() => {
      setSearch(next);
      setPage(1);
    }, 200);
    return () => clearTimeout(timer);
  }, [query, search]);
  const current = kind ?? shown ?? 'lfs';
  const answer = files.data ?? kept;
  const data = answer?.kind === current ? answer : undefined;
  const list = data ? rows(data) : [];
  const range = data ? pageRange(data, formatCount) : null;
  return (
    <Dialog open={!!kind} onClose={onClose} title={titles[current]} className="v2-storage-dialog">
      <label className="dl-field">
        <Icon name="search" />
        <input
          type="text"
          placeholder="Search files"
          aria-label="Search files"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {files.error && !files.data ? (
        <Banner
          kind="danger"
          title="Couldn't load the files"
          action={<Action onClick={files.refresh}>Try again</Action>}
        />
      ) : !data ? (
        <Skeleton rows={6} label="Loading files" />
      ) : (
        <>
          <div className="v2-storage-line" aria-live="polite">
            <span>{listLine(data, formatCount)}</span>
            <span>Measured {midSentence(formatTime(data.measuredAt))}</span>
          </div>
          {list.length ? (
            <div className="dl-group dl-table-wrap v2-storage-table">
              <table className="dl-table">
                <thead>
                  <tr>
                    {columns[current].map((column) => {
                      const sorted = sort.key === column.key;
                      return (
                        <th
                          key={column.key}
                          className={`${column.number ? 'v2-storage-number' : ''} ${column.wide ? 'v2-storage-wide' : ''}`}
                          aria-sort={sorted ? sort.direction : undefined}
                        >
                          <button
                            type="button"
                            className="v2-storage-sort"
                            data-sorted={sorted || undefined}
                            onClick={() => {
                              setSort(nextSort(sort, column.key));
                              setPage(1);
                            }}
                          >
                            {column.label}
                            {sorted && (
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.75"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                              >
                                <path
                                  d={
                                    sort.direction === 'descending'
                                      ? 'M12 5v14M6 13l6 6 6-6'
                                      : 'M12 19V5M6 11l6-6 6 6'
                                  }
                                />
                              </svg>
                            )}
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {list.map((row) => (
                    <tr key={row.key}>
                      <td className="dl-name">
                        <span className="dl-mono">{row.name}</span>
                        {row.tag && <span className="dl-tag v2-storage-tag">{row.tag}</span>}
                      </td>
                      {current === 'history' && (
                        <td className="v2-storage-number">{formatCount(row.versions ?? 0)}</td>
                      )}
                      <td>{ageLabel(row.at, now)}</td>
                      <td className="v2-storage-number v2-storage-size">
                        {formatBytes(row.bytes)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="dl-group">
              <div className="dl-empty v2-storage-empty">
                <h3>{data.query ? `No files match “${data.query}”` : 'No files'}</h3>
                {data.query && <p>Search looks at file paths.</p>}
              </div>
            </div>
          )}
          {range && (
            <div className="v2-storage-pages">
              <span className="dl-meta">{range.text}</span>
              <span className="dl-end">
                <Action disabled={!range.previous} onClick={() => setPage(data.page - 1)}>
                  Previous
                </Action>
                <Action disabled={!range.next} onClick={() => setPage(data.page + 1)}>
                  Next
                </Action>
              </span>
            </div>
          )}
        </>
      )}
      <p className="v2-storage-note">{footnotes[current]}</p>
    </Dialog>
  );
}
