'use client';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-flight-router/client';
import {
  Banner,
  ChipSelect,
  Dialog,
  Group,
  Head,
  Icon,
  IconButton,
  Setting,
} from '@/components/ui';
import { request, useData } from '../projects/data';
import { useProjectFormatting } from '../projects/formatting';
import {
  bytes,
  count,
  countLine,
  changeQuery,
  keptPath,
  keptEntryPath,
  kindLabel,
  toggleKind,
  removalNotice,
  removalDescription,
  removalPromise,
  projectNames,
} from './kept-model';

function KeptLayout({
  title,
  subtitle,
  back,
  children,
}: {
  title: string;
  subtitle?: string;
  back: string;
  children: ReactNode;
}) {
  return (
    <>
      <Head
        title={title}
        subtitle={subtitle}
        menu={
          <>
            <IconButton
              icon="menu"
              label="Show sidebar"
              className="dl-menu-btn"
              onClick={() => window.dispatchEvent(new Event('deploy:v2-sidebar'))}
            />
            <a className="dl-icon-btn" href={back} aria-label="Back">
              ‹
            </a>
          </>
        }
      />
      <div className="dl-scroll">
        <div className="dl-page packages-detail">{children}</div>
      </div>
    </>
  );
}
function NeededTag({
  projects,
  needed,
  detail = false,
  total = projects.length,
}: {
  projects: { id: string; name: string }[];
  needed: boolean;
  detail?: boolean;
  total?: number;
}) {
  if (!needed) return null;
  return (
    <span className="dl-tag">
      Needed by{' '}
      {projects.length
        ? detail
          ? projects.map((p) => p.name).join(', ') +
            (total > projects.length ? ` and ${total - projects.length} more` : '')
          : total === 1
            ? projects[0].name
            : `${total} projects`
        : 'projects'}
    </span>
  );
}
function useInstalledDate() {
  const { now, localeDate } = useProjectFormatting();
  return (value: string) =>
    localeDate(value, { year: 'numeric', month: 'numeric', day: 'numeric' }) ===
    localeDate(new Date(now).toISOString(), { year: 'numeric', month: 'numeric', day: 'numeric' })
      ? 'today'
      : localeDate(value, { month: 'short', day: 'numeric' }, false, 'en-US');
}
export function KindMenu({
  kind,
  counts,
  onChange,
}: {
  kind: string;
  counts: Record<string, number>;
  onChange: (kind: string) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => menu.current?.hidePopover();
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);
  return (
    <span className="packages-kind">
      <button
        ref={trigger}
        className="dl-chip"
        popoverTarget={id}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
      >
        {kindLabel(kind)} <Icon name="down" size={12} />
      </button>
      <div
        ref={menu}
        id={id}
        popover="auto"
        role="menu"
        aria-label="Show"
        className="dl-menu packages-kind-menu"
        onToggle={(event) => {
          const shown = event.newState === 'open';
          setOpen(shown);
          if (shown && menu.current && trigger.current) {
            const box = trigger.current.getBoundingClientRect();
            menu.current.style.left = `${Math.min(box.left, window.innerWidth - menu.current.offsetWidth)}px`;
            menu.current.style.top = `${box.bottom + 4}px`;
            menu.current.querySelector<HTMLButtonElement>('button')?.focus();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            menu.current?.hidePopover();
            trigger.current?.focus();
          }
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const buttons = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('button'));
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            buttons[
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
            ]?.focus();
          }
        }}
      >
        <span className="dl-menu-label">Show</span>
        {(['npm', 'cargo'] as const).map((value) => (
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={kind === 'all' || kind === value}
            aria-disabled={kind === value}
            className="dl-menu-item"
            key={value}
            onClick={() => {
              const next = toggleKind(kind, value);
              if (next !== kind) onChange(next);
            }}
          >
            <span className="packages-check">
              {(kind === 'all' || kind === value) && <Icon name="tick" size={14} />}
            </span>
            {value === 'npm' ? 'npm packages' : 'Cargo crates'}
            <span className="dl-end">{count(counts[value] || 0)}</span>
          </button>
        ))}
      </div>
    </span>
  );
}
export function RemoveCopies({
  path,
  versions,
  packages,
  size,
  idle,
  onRemoved,
  label,
}: {
  path: string;
  versions: number;
  packages: number;
  size: number;
  idle: boolean;
  onRemoved: (notice: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const {
    data: status,
    error: statusError,
    refresh: refreshStatus,
  } = useData<any>(open ? '/api/packages/cache' : undefined);
  const unavailable =
    status?.sources.filter((source: any) => !source.reachable).map((source: any) => source.name) ||
    [];
  async function remove() {
    setBusy(true);
    setError('');
    try {
      const result = await request(path, { method: 'POST' });
      onRemoved(removalNotice(result));
      setOpen(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not remove copies');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className={idle ? 'dl-btn primary' : 'dl-btn'}
        onClick={() => {
          setError('');
          setOpen(true);
        }}
      >
        {label}
      </button>
      <Dialog
        className="packages-remove-dialog"
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        title={`Remove ${bytes(size)} from the copy?`}
        loading={busy}
        actions={
          <>
            <button className="dl-btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="dl-btn primary" disabled={!status} onClick={() => void remove()}>
              Remove {bytes(size)}
            </button>
          </>
        }
      >
        <p>{removalDescription(versions, packages, idle)}</p>
        <p>{removalPromise}</p>
        {unavailable.length > 0 && (
          <p>
            {unavailable.join(' and ')} can’t be reached. Removed packages can’t be fetched again
            until {unavailable.length === 1 ? 'it’s' : 'they’re'} back.
          </p>
        )}
        {statusError && (
          <Banner kind="danger" title={statusError}>
            <button className="dl-btn" onClick={refreshStatus}>
              Retry
            </button>
          </Banner>
        )}
        {error && <Banner kind="danger" title={error} />}
      </Dialog>
    </>
  );
}
export function KeptList() {
  const [search, setSearch] = useSearchParams();
  const query = search.toString();
  const { data, error, refresh } = useData<any>(
    '/api/packages/cache/kept' + (query ? '?' + query : ''),
  );
  const [notice, setNotice] = useState('');
  const installed = useInstalledDate();
  const idle = search.get('time') === 'idle';
  const kind = search.get('kind') || 'all';
  const update = (key: string, value: string) => setSearch(changeQuery(search, key, value));
  return (
    <KeptLayout title="Everything kept" back="/dashboard/packages?tab=copies">
      {notice && <Banner title={notice} />}
      {error && <Banner kind="danger" title={error} />}
      <div className="packages-top">
        <p className="packages-summary" aria-live="polite">
          {data ? countLine(data, idle) : 'Counting…'}
        </p>
        <label className="dl-field">
          <Icon name="search" size={16} />
          <input
            type="search"
            aria-label="Search packages and crates"
            placeholder="Search packages and crates"
            value={search.get('q') || ''}
            onChange={(event) => update('q', event.target.value)}
          />
        </label>
        <div className="packages-tools">
          <KindMenu
            kind={kind}
            counts={data?.kinds || {}}
            onChange={(value) => update('kind', value)}
          />
          <ChipSelect
            label="Installed"
            value={idle ? 'idle' : 'any'}
            options={[
              { value: 'any', label: 'Any time' },
              { value: 'idle', label: 'Not installed in 30 days' },
            ]}
            onChange={(value) => update('time', value)}
          />
          <ChipSelect
            label="Sort"
            value={search.get('sort') || 'size'}
            options={[
              { value: 'size', label: 'Largest first' },
              { value: 'name', label: 'Name' },
              { value: 'installed', label: 'Last installed' },
            ]}
            onChange={(value) => update('sort', value)}
          />
        </div>
      </div>
      <Group>
        {data?.entries.map((entry: any) => (
          <a
            className="dl-item"
            key={`${entry.ecosystem}:${entry.name}`}
            href={keptEntryPath(entry.ecosystem, entry.name)}
          >
            <span className="dl-t">
              <span className="dl-mono">{entry.name}</span>
              <span>
                {entry.ecosystem === 'npm' ? 'npm' : 'Cargo crate'} · {count(entry.versions)}{' '}
                {idle && entry.allVersions > entry.versions ? 'unused versions' : 'versions'} · last
                installed {installed(entry.lastInstalled)}
              </span>
            </span>
            <span className="packages-end">
              <NeededTag
                projects={entry.neededBy}
                total={entry.neededByCount}
                needed={!!entry.needed}
              />
              <span className="dl-c packages-count">{bytes(entry.bytes)}</span>
            </span>
            <span className="dl-chev">
              <Icon name="chevron" size={14} />
            </span>
          </a>
        ))}
      </Group>
      {data && !data.packages && (
        <p className="dl-list-note">
          {search.get('q') ? (
            <>
              No package or crate matches {search.get('q')}{' '}
              <button className="dl-btn" onClick={() => update('q', '')}>
                Clear
              </button>
            </>
          ) : idle ? (
            'Everything was installed in the last 30 days'
          ) : (
            'Nothing kept yet. The first install through deploy.local appears here.'
          )}
        </p>
      )}
      {!!data?.packages && (
        <div className="packages-pager">
          <span>
            {count((data.page - 1) * 50 + 1)}–{count(Math.min(data.page * 50, data.packages))} of{' '}
            {count(data.packages)}
          </span>
          <span className="packages-tools">
            <button
              className="dl-btn"
              disabled={data.page <= 1}
              onClick={() => update('page', String(data.page - 1))}
            >
              Previous
            </button>
            <button
              className="dl-btn"
              disabled={data.page * 50 >= data.packages}
              onClick={() => update('page', String(data.page + 1))}
            >
              Next
            </button>
          </span>
        </div>
      )}
      {idle && (
        <div className="packages-foot">
          <p className="packages-summary">Versions a project needs are never listed here.</p>
          {data?.canRemove && data.versions > 0 && (
            <RemoveCopies
              path={'/api/packages/cache/kept/remove?' + query}
              versions={data.versions}
              packages={data.packages}
              size={data.bytes}
              idle
              label={`Remove ${count(data.versions)} versions · ${bytes(data.bytes)}…`}
              onRemoved={(value) => {
                setNotice(value);
                refresh();
              }}
            />
          )}
        </div>
      )}
    </KeptLayout>
  );
}
export function KeptPackage({ ecosystem, name }: { ecosystem: string; name: string }) {
  const path = `/api/packages/cache/entry/${ecosystem}/${encodeURIComponent(name)}`;
  const { data, error, refresh } = useData<any>(path);
  const [extra, setExtra] = useState<any[]>([]);
  const [all, setAll] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const installed = useInstalledDate();
  async function showAll() {
    setLoading(true);
    setLoadError('');
    try {
      const rows: any[] = [];
      for (let offset = 5; offset < data.totalVersions; offset += 100) {
        const page = await request(`${path}?all=1&offset=${offset}`);
        rows.push(...page.versions);
        if (page.versions.length < 100) break;
      }
      setExtra(rows);
      setAll(true);
    } catch (failure) {
      setLoadError(failure instanceof Error ? failure.message : 'Could not load versions');
    } finally {
      setLoading(false);
    }
  }
  const total = data?.totalVersions || 0;
  return (
    <KeptLayout
      title={name}
      subtitle={`${ecosystem === 'npm' ? 'npm package' : 'Cargo crate'} · in the copy`}
      back={keptPath}
    >
      {notice && <Banner title={notice} />}
      {(error || loadError) && <Banner kind="danger" title={error || loadError} />}
      {!data ? (
        <p className="packages-summary">Counting…</p>
      ) : (
        <>
          <section className="dl-section packages-board-section">
            <Group>
              <div className="dl-inset">
                <Setting
                  label="Kept"
                  description={`${count(total)} versions, fetched from ${ecosystem === 'npm' ? 'npmjs.org' : 'crates.io'}`}
                >
                  {bytes(data.bytes)}
                </Setting>
                <Setting
                  label="Needed by"
                  description={
                    projectNames(data.neededBy.map((p: any) => p.name)) +
                      (data.neededByCount > data.neededBy.length
                        ? ` and ${data.neededByCount - data.neededBy.length} more`
                        : '') || (data.cargoProtected ? 'Projects' : 'No projects')
                  }
                >
                  {count(data.neededVersions)} versions
                </Setting>
              </div>
            </Group>
          </section>
          <section className="dl-section packages-board-section">
            <h2 className="dl-section-title">Versions</h2>
            <Group>
              {[...data.versions, ...(all ? extra : [])].map((version: any) => (
                <div className="dl-item" key={version.version}>
                  <span className="dl-t">
                    <span className="dl-mono">{version.version}</span>
                    <span>last installed {installed(version.lastInstalled)}</span>
                  </span>
                  <span className="packages-end">
                    <NeededTag
                      projects={version.neededBy}
                      total={version.neededByCount}
                      needed={!!version.needed}
                      detail
                    />
                    <span className="dl-c packages-count">{bytes(version.bytes)}</span>
                  </span>
                </div>
              ))}
            </Group>
            {!total && (
              <p className="dl-list-note">
                Nothing kept yet. The first install through deploy.local appears here.
              </p>
            )}
            {!all && total > 5 && (
              <div className="packages-pager">
                <span>5 of {count(total)}, newest first</span>
                <button className="dl-btn" disabled={loading} onClick={() => void showAll()}>
                  {loading ? 'Counting…' : 'Show all'}
                </button>
              </div>
            )}
            <div className="packages-foot">
              <p className="packages-summary">
                {count(data.unusedVersions)} versions no project needs · {bytes(data.unusedBytes)}
              </p>
              {data.canRemove && data.unusedVersions > 0 && (
                <RemoveCopies
                  path={`/api/packages/cache/remove/${ecosystem}/${encodeURIComponent(name)}`}
                  versions={data.unusedVersions}
                  packages={1}
                  size={data.unusedBytes}
                  idle={false}
                  label="Remove unused versions…"
                  onRemoved={(value) => {
                    setNotice(value);
                    setAll(false);
                    setExtra([]);
                    refresh();
                  }}
                />
              )}
            </div>
          </section>
        </>
      )}
    </KeptLayout>
  );
}
