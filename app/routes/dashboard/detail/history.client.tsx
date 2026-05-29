'use client';

import { useMemo, useState, useEffect, useCallback } from 'react';
import { Link } from 'react-flight-router/client';
import {
  fetchDeployHistory as serverFetchHistory,
  fetchBackups as serverFetchBackups,
  createBackup as serverCreateBackup,
  restoreBackup as serverRestoreBackup,
  deleteBackup as serverDeleteBackup,
} from '../../../actions/deployments';
import { getAuth, useDetailContext } from './shared';
import { formatBytes } from '../../../utils';
import { LoadingState, ErrorBanner } from '../../../components/LoadingState';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { DayGroup, type DayGroupItem } from '../../../components/dashboard/DayGroup';
import { EmptyState } from '../../../components/dashboard/EmptyState';
import {
  HistoryIcon,
  BuildIcon,
  RotateIcon,
  AlertTriangleIcon,
  PlusIcon,
  BackupsIcon,
} from '../../../components/dashboard/icons';

interface HistoryEvent {
  id?: number;
  action: string;
  username: string | null;
  timestamp: string;
  type?: string | null;
  port?: number | null;
  containerId?: string | null;
  buildLogId?: number | null;
  durationMs?: number | null;
  source?: 'cli' | 'ui' | 'auto' | null;
}

interface Backup {
  id: number;
  filename: string;
  label: string | null;
  sizeBytes: number;
  createdBy: string;
  createdAt: string;
  auto?: boolean;
  relatedBuildLogId?: number | null;
}

// Unified item — either an HistoryEvent or a Backup with its own actions.
type ActivityItem =
  | { kind: 'history'; at: string; event: HistoryEvent }
  | { kind: 'backup'; at: string; backup: Backup };

type FilterKey = 'all' | 'deploys' | 'restarts' | 'backups' | 'config';

function classifyHistory(action: string): Exclude<FilterKey, 'all' | 'backups'> | 'backups' | null {
  if (action === 'deploy') return 'deploys';
  if (action === 'restart' || action === 'recreate') return 'restarts';
  if (action === 'backup' || action === 'restore') return 'backups';
  if (action === 'delete') return null; // a delete is rare; show in 'all'
  if (action.endsWith('-update')) return 'config';
  return null;
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${Math.round(sec % 60)}s`;
}

function actionMeta(action: string) {
  switch (action) {
    case 'deploy':
      return { label: 'Deploy', icon: <BuildIcon />, tone: 'success' as const };
    case 'restart':
      return { label: 'Restart', icon: <RotateIcon />, tone: 'warning' as const };
    case 'recreate':
      return { label: 'Recreate', icon: <RotateIcon />, tone: 'warning' as const };
    case 'delete':
      return { label: 'Delete', icon: <AlertTriangleIcon />, tone: 'danger' as const };
    case 'backup':
      return { label: 'Backup', icon: <BackupsIcon />, tone: 'default' as const };
    case 'restore':
      return { label: 'Restore', icon: <BackupsIcon />, tone: 'warning' as const };
    case 'env-update':
    case 'memory-update':
    case 'volumes-update':
    case 'gpu-update':
    case 'privileged-docker-update':
      return { label: action.replace('-', ' '), icon: <PlusIcon />, tone: 'default' as const };
    default:
      return { label: action, icon: <HistoryIcon />, tone: 'default' as const };
  }
}

const toneClass: Record<'success' | 'warning' | 'danger' | 'default', string> = {
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-danger/10 text-danger',
  default: 'bg-bg-hover text-text-tertiary',
};

const sourceLabel: Record<'cli' | 'ui' | 'auto', { label: string; cls: string }> = {
  cli: { label: 'CLI', cls: 'bg-bg-hover text-text-secondary' },
  ui: { label: 'UI', cls: 'bg-accent/10 text-accent' },
  auto: { label: 'Auto', cls: 'bg-warning/10 text-warning' },
};

export default function Component() {
  const { deployment, fetchDeployment } = useDetailContext();
  const name = deployment.name;

  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [volumeSize, setVolumeSize] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    danger: boolean;
    onConfirm: () => void;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const auth = getAuth();
      if (!auth) return;
      const [hist, backupData] = await Promise.all([
        serverFetchHistory(auth.username, auth.token, name),
        serverFetchBackups(auth.username, auth.token, name),
      ]);
      setEvents(hist as HistoryEvent[]);
      setBackups(backupData.backups as Backup[]);
      setVolumeSize(backupData.volumeSize);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreateBackup = async () => {
    if (creating) return;
    setCreating(true);
    setError('');
    try {
      const auth = getAuth();
      if (!auth) return;
      await serverCreateBackup(auth.username, auth.token, name);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleRestore = (b: Backup) => {
    setConfirmState({
      title: 'Restore backup',
      message: `Restore "${b.filename}"? This will replace current data and restart the container.`,
      confirmLabel: 'Restore',
      danger: false,
      onConfirm: async () => {
        setConfirmState(null);
        setRestoring(b.filename);
        setError('');
        setSuccessMessage('');
        try {
          const auth = getAuth();
          if (!auth) return;
          await serverRestoreBackup(auth.username, auth.token, name, b.filename);
          await fetchDeployment();
          setSuccessMessage('Backup restored successfully.');
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setRestoring(null);
        }
      },
    });
  };

  const handleDelete = (b: Backup) => {
    setConfirmState({
      title: 'Delete backup',
      message: `Delete "${b.filename}"? This action cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: async () => {
        setConfirmState(null);
        setDeleting(b.filename);
        setError('');
        try {
          const auth = getAuth();
          if (!auth) return;
          await serverDeleteBackup(auth.username, auth.token, name, b.filename);
          await load();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setDeleting(null);
        }
      },
    });
  };

  // Merged + filtered timeline
  const items: DayGroupItem<ActivityItem>[] = useMemo(() => {
    const merged: ActivityItem[] = [
      ...events.map((e): ActivityItem => ({ kind: 'history', at: e.timestamp, event: e })),
      ...backups.map((b): ActivityItem => ({ kind: 'backup', at: b.createdAt, backup: b })),
    ];

    let filtered = merged;
    if (filter === 'deploys') {
      filtered = merged.filter(
        (m) => m.kind === 'history' && classifyHistory(m.event.action) === 'deploys',
      );
    } else if (filter === 'restarts') {
      filtered = merged.filter(
        (m) => m.kind === 'history' && classifyHistory(m.event.action) === 'restarts',
      );
    } else if (filter === 'backups') {
      // Show backup objects (richer) — and any history rows tagged 'backup'/'restore'
      filtered = merged.filter(
        (m) =>
          m.kind === 'backup' ||
          (m.kind === 'history' && classifyHistory(m.event.action) === 'backups'),
      );
    } else if (filter === 'config') {
      filtered = merged.filter(
        (m) => m.kind === 'history' && classifyHistory(m.event.action) === 'config',
      );
    }

    return filtered
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .map((m) => ({ at: m.at, item: m }));
  }, [events, backups, filter]);

  // Last-30-days deploy strip (only deploy events)
  const strip = useMemo(() => {
    const dayBuckets: Map<string, { success: number; fail: number; total: number }> = new Map();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      dayBuckets.set(d.toDateString(), { success: 0, fail: 0, total: 0 });
    }
    for (const e of events) {
      if (e.action !== 'deploy') continue;
      const d = new Date(e.timestamp);
      d.setHours(0, 0, 0, 0);
      const key = d.toDateString();
      const bucket = dayBuckets.get(key);
      if (!bucket) continue;
      bucket.total++;
      bucket.success++;
    }
    return Array.from(dayBuckets.entries()).map(([key, v]) => ({ key, ...v }));
  }, [events]);

  const counts = useMemo(
    () => ({
      all: events.length + backups.length,
      deploys: events.filter((e) => e.action === 'deploy').length,
      restarts: events.filter((e) => e.action === 'restart' || e.action === 'recreate').length,
      backups: backups.length + events.filter((e) => e.action === 'restore').length,
      config: events.filter((e) => e.action.endsWith('-update')).length,
    }),
    [events, backups],
  );

  if (loading) return <LoadingState />;

  return (
    <div className="space-y-4 sm:space-y-5">
      {error && <ErrorBanner message={error} />}

      {/* 30-day deploy timeline */}
      {strip.some((d) => d.total > 0) && (
        <div className="card p-3 sm:p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="eyebrow">Deploys, last 30 days</p>
            <p className="text-[11px] font-mono text-text-tertiary tabular-nums">
              {strip.reduce((a, d) => a + d.total, 0)} total
            </p>
          </div>
          <div
            className="grid gap-0.5"
            style={{ gridTemplateColumns: 'repeat(30, minmax(0, 1fr))' }}
          >
            {strip.map((d) => {
              const intensity = d.total === 0 ? 0 : Math.min(1, d.success / 3);
              return (
                <div
                  key={d.key}
                  title={`${new Date(d.key).toLocaleDateString()}: ${d.total} deploy${d.total === 1 ? '' : 's'}`}
                  className="h-5 rounded-sm"
                  style={{
                    backgroundColor:
                      d.total === 0
                        ? 'var(--color-bg-hover)'
                        : d.fail > 0
                          ? 'var(--color-danger)'
                          : 'var(--color-success)',
                    opacity: d.total === 0 ? 0.4 : 0.3 + intensity * 0.7,
                  }}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Action bar — filter chips + Backup-now button + volume info */}
      <div className="flex flex-wrap items-center gap-2">
        <FilterChip
          label="All"
          count={counts.all}
          active={filter === 'all'}
          onClick={() => setFilter('all')}
        />
        <FilterChip
          label="Deploys"
          count={counts.deploys}
          active={filter === 'deploys'}
          onClick={() => setFilter('deploys')}
        />
        <FilterChip
          label="Restarts"
          count={counts.restarts}
          active={filter === 'restarts'}
          onClick={() => setFilter('restarts')}
        />
        <FilterChip
          label="Backups"
          count={counts.backups}
          active={filter === 'backups'}
          onClick={() => setFilter('backups')}
        />
        <FilterChip
          label="Config"
          count={counts.config}
          active={filter === 'config'}
          onClick={() => setFilter('config')}
        />
        <div className="flex-1" />
        <span className="text-[11px] font-mono text-text-tertiary tabular-nums">
          volume {formatBytes(volumeSize)}
        </span>
        <button
          onClick={handleCreateBackup}
          disabled={creating}
          className="btn btn-sm inline-flex items-center gap-1.5"
        >
          <BackupsIcon className="w-3.5 h-3.5" />
          {creating ? 'Backing up…' : 'Backup now'}
        </button>
      </div>

      {/* Large volume contextual warning (only when on backups filter or all) */}
      {volumeSize > 10 * 1024 * 1024 * 1024 && (filter === 'backups' || filter === 'all') && (
        <div className="card p-3 bg-warning/8 border-warning/30 flex items-start gap-2">
          <AlertTriangleIcon className="text-warning shrink-0 mt-0.5" />
          <p className="text-xs text-text-secondary leading-relaxed">
            Volume is {formatBytes(volumeSize)} — backups may take several minutes. They run
            asynchronously without blocking the server.
          </p>
        </div>
      )}

      {/* Success banner */}
      {successMessage && (
        <div className="rounded-lg border border-success/30 bg-success/10 px-4 py-3 text-sm text-success flex items-center justify-between">
          {successMessage}
          <button
            onClick={() => setSuccessMessage('')}
            className="text-success/70 hover:text-success ml-2 min-w-[24px] min-h-[24px]"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Empty / list */}
      {items.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<HistoryIcon />}
            title="Nothing here yet"
            description={
              filter === 'all'
                ? 'Deploys, restarts, configuration changes, and backups will appear here as they happen.'
                : 'No activity in this category yet.'
            }
          />
        </div>
      ) : (
        <DayGroup
          items={items}
          renderItem={(item, at) =>
            item.kind === 'history' ? (
              <HistoryRow event={item.event} at={at} name={name} />
            ) : (
              <BackupRow
                backup={item.backup}
                at={at}
                name={name}
                restoring={restoring}
                deleting={deleting}
                onRestore={() => handleRestore(item.backup)}
                onDelete={() => handleDelete(item.backup)}
              />
            )
          }
        />
      )}

      <ConfirmDialog
        open={confirmState !== null}
        title={confirmState?.title ?? ''}
        message={confirmState?.message ?? ''}
        confirmLabel={confirmState?.confirmLabel}
        danger={confirmState?.danger}
        onConfirm={() => confirmState?.onConfirm()}
        onCancel={() => setConfirmState(null)}
      />
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
        active
          ? 'bg-accent/15 text-accent'
          : 'bg-bg-surface text-text-secondary hover:bg-bg-hover hover:text-text'
      }`}
    >
      <span>{label}</span>
      <span
        className={`font-mono tabular-nums text-[10px] ${
          active ? 'text-accent/70' : 'text-text-tertiary'
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function HistoryRow({ event, at, name }: { event: HistoryEvent; at: Date; name: string }) {
  const meta = actionMeta(event.action);
  const source = event.source ? sourceLabel[event.source] : null;
  const isDeploy = event.action === 'deploy';
  return (
    <div className="card p-3 flex items-start gap-3">
      <span
        className={`inline-flex items-center justify-center w-7 h-7 rounded-md shrink-0 ${toneClass[meta.tone]}`}
        aria-hidden
      >
        {meta.icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium capitalize">{meta.label}</span>
          {source && (
            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${source.cls}`}>
              {source.label}
            </span>
          )}
          {event.type && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-bg-hover text-text-tertiary">
              {event.type}
            </span>
          )}
          {isDeploy && event.durationMs != null && (
            <span className="text-[10px] font-mono text-text-tertiary tabular-nums">
              took {formatDuration(event.durationMs)}
            </span>
          )}
        </div>
        <p className="text-xs text-text-secondary mt-0.5">
          {event.username ? `by ${event.username}` : 'system'}
          {event.port ? ` · port ${event.port}` : ''}
          {event.containerId ? ` · ${event.containerId.slice(0, 8)}` : ''}
        </p>
        {event.buildLogId && (
          <Link
            to={`/dashboard/${name}/build?selected=${event.buildLogId}`}
            className="mt-2 text-[11px] text-accent hover:underline inline-flex items-center gap-1"
          >
            <BuildIcon className="w-3 h-3" />
            Build #{event.buildLogId}
          </Link>
        )}
      </div>
      <time
        className="text-[11px] font-mono text-text-tertiary shrink-0 whitespace-nowrap tabular-nums"
        dateTime={event.timestamp}
      >
        {at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </time>
    </div>
  );
}

function BackupRow({
  backup,
  at,
  name,
  restoring,
  deleting,
  onRestore,
  onDelete,
}: {
  backup: Backup;
  at: Date;
  name: string;
  restoring: string | null;
  deleting: string | null;
  onRestore: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="card p-3 flex items-start gap-3">
      <span
        className="inline-flex items-center justify-center w-7 h-7 rounded-md shrink-0 bg-bg-hover text-text-tertiary"
        aria-hidden
      >
        <BackupsIcon />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium">Backup</span>
          {backup.auto ? (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-warning/10 text-warning">
              Auto
            </span>
          ) : (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-bg-hover text-text-tertiary">
              Manual
            </span>
          )}
          {backup.label && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent/10 text-accent">
              {backup.label}
            </span>
          )}
          <span className="text-[10px] font-mono text-text-tertiary tabular-nums">
            {formatBytes(backup.sizeBytes)}
          </span>
        </div>
        <p className="text-xs text-text-secondary mt-0.5 font-mono truncate">{backup.filename}</p>
        <p className="text-xs text-text-secondary mt-0.5">by {backup.createdBy}</p>
        {backup.relatedBuildLogId && (
          <Link
            to={`/dashboard/${name}/build?selected=${backup.relatedBuildLogId}`}
            className="mt-1 text-[11px] text-accent hover:underline inline-flex items-center gap-1"
          >
            <BuildIcon className="w-3 h-3" />
            Build #{backup.relatedBuildLogId}
          </Link>
        )}
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        <time
          className="text-[11px] font-mono text-text-tertiary whitespace-nowrap tabular-nums"
          dateTime={backup.createdAt}
        >
          {at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </time>
        <div className="flex gap-1.5">
          <button
            onClick={onRestore}
            disabled={restoring === backup.filename}
            className="btn btn-sm"
          >
            {restoring === backup.filename ? 'Restoring…' : 'Restore'}
          </button>
          <button
            onClick={onDelete}
            disabled={deleting === backup.filename}
            className="btn btn-sm btn-danger"
          >
            {deleting === backup.filename ? '…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
