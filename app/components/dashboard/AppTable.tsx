'use client';

import { useMemo, useState } from 'react';
import { Link } from 'react-flight-router/client';
import { MiniSparkline } from './Sparkline';
import { appUrl } from '../../routes/dashboard/detail/shared';
import { formatBytes } from '../../utils';
import type { AppCardData, Severity } from './AppCard';

type SortField = 'name' | 'severity' | 'rps' | 'cpu' | 'mem' | 'p95' | 'err';
type SortDir = 'asc' | 'desc';

const SEVERITY_ORDER: Record<Severity, number> = {
  down: 0,
  degraded: 1,
  building: 2,
  healthy: 3,
  idle: 4,
};

const SEVERITY_DOT: Record<Severity, string> = {
  healthy: 'bg-success',
  degraded: 'bg-warning',
  down: 'bg-danger',
  idle: 'bg-text-tertiary',
  building: 'bg-warning',
};

// Label shown next to the severity dot. Both `healthy` and `idle` are
// running containers — `idle` just means no traffic in the current window.
// "Idle" reads as "stopped" to most operators, so collapse to "Running"
// and let the per-row req/s + colored dot carry the nuance.
const SEVERITY_LABEL: Record<Severity, string> = {
  healthy: 'Running',
  degraded: 'Degraded',
  down: 'Down',
  idle: 'Running',
  building: 'Building',
};

/**
 * Sortable, hover-actionable table for the global dashboard.
 *
 * Each row corresponds to one deployment. Columns expose the same metrics
 * the AppCard surfaced, but in a denser, more scannable form — the kind of
 * table the operator of a real PaaS expects: click headers to sort, hover
 * to reveal row actions, click anywhere on the row to drill into the app.
 */
export function AppTable({
  cards,
  onDelete,
  onBulkRestart,
  onBulkDelete,
}: {
  cards: AppCardData[];
  onDelete: (name: string) => void;
  /** Optional bulk handlers. When omitted, the selection column + action
      bar are hidden — the table degrades to its previous read-only form. */
  onBulkRestart?: (names: string[]) => void;
  onBulkDelete?: (names: string[]) => void;
}) {
  const [sortField, setSortField] = useState<SortField>('severity');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const supportsBulk = !!(onBulkRestart || onBulkDelete);

  const sorted = useMemo(() => {
    const arr = cards.slice();
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'name':
          cmp = a.name.localeCompare(b.name);
          break;
        case 'severity':
          cmp = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
          if (cmp === 0) cmp = b.rps - a.rps;
          break;
        case 'rps':
          cmp = a.rps - b.rps;
          break;
        case 'cpu':
          cmp = a.cpuPercent - b.cpuPercent;
          break;
        case 'mem':
          cmp = a.memPercent - b.memPercent;
          break;
        case 'p95':
          cmp = a.p95 - b.p95;
          break;
        case 'err':
          cmp = a.errPct - b.errPct;
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [cards, sortField, sortDir]);

  function toggleSort(field: SortField) {
    if (field === sortField) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      // Default direction per column: ascending for name/severity, descending for metrics
      setSortDir(field === 'name' || field === 'severity' ? 'asc' : 'desc');
    }
  }

  const visibleNames = sorted.map((r) => r.name);
  const allSelected = visibleNames.length > 0 && visibleNames.every((n) => selected.has(n));
  const someSelected = !allSelected && visibleNames.some((n) => selected.has(n));
  const selectedNames = visibleNames.filter((n) => selected.has(n));

  function toggleSelect(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) => {
      if (allSelected) {
        const next = new Set(prev);
        for (const n of visibleNames) next.delete(n);
        return next;
      }
      const next = new Set(prev);
      for (const n of visibleNames) next.add(n);
      return next;
    });
  }

  return (
    <div className="card-hero overflow-hidden">
      {/* Sticky selection action bar — only renders when at least one row
          is selected AND the parent wired up bulk handlers. Sits inside
          the card-hero so it visually attaches to the table. */}
      {supportsBulk && selectedNames.length > 0 && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-white/[0.06] bg-bg/60 backdrop-blur-sm">
          <p className="text-xs text-text-secondary tabular-nums">
            <span className="text-text font-medium">{selectedNames.length}</span> selected
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-xs text-text-tertiary hover:text-text-secondary transition-colors"
            >
              Clear
            </button>
            {onBulkRestart && (
              <button
                type="button"
                onClick={() => onBulkRestart(selectedNames)}
                className="btn btn-sm text-xs"
              >
                Restart
              </button>
            )}
            {onBulkDelete && (
              <button
                type="button"
                onClick={() => onBulkDelete(selectedNames)}
                className="btn btn-sm btn-danger text-xs"
              >
                Delete
              </button>
            )}
          </div>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm relative">
          <thead>
            <tr className="border-b border-white/[0.06] bg-bg/40 backdrop-blur-sm">
              {supportsBulk && (
                <th className="pl-4 pr-1 w-[36px]">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => {
                      // Indeterminate state when some but not all rows
                      // are selected — improves at-a-glance status when
                      // the user scrolls the table.
                      if (el) el.indeterminate = someSelected;
                    }}
                    onChange={toggleSelectAll}
                    aria-label="Select all"
                    className="accent-accent cursor-pointer"
                  />
                </th>
              )}
              <SortHeader
                field="severity"
                label="Status"
                sortField={sortField}
                sortDir={sortDir}
                onSort={toggleSort}
                className="pl-4 pr-2 w-[120px]"
              />
              <SortHeader
                field="name"
                label="App"
                sortField={sortField}
                sortDir={sortDir}
                onSort={toggleSort}
                className="px-2 min-w-[180px]"
              />
              <SortHeader
                field="rps"
                label="Req/s"
                align="right"
                sortField={sortField}
                sortDir={sortDir}
                onSort={toggleSort}
                className="px-2 w-[140px]"
              />
              <SortHeader
                field="cpu"
                label="CPU"
                align="right"
                sortField={sortField}
                sortDir={sortDir}
                onSort={toggleSort}
                className="px-2 w-[80px]"
              />
              <SortHeader
                field="mem"
                label="Memory"
                align="right"
                sortField={sortField}
                sortDir={sortDir}
                onSort={toggleSort}
                className="px-2 w-[140px]"
              />
              <SortHeader
                field="p95"
                label="p95"
                align="right"
                sortField={sortField}
                sortDir={sortDir}
                onSort={toggleSort}
                className="px-2 w-[90px]"
              />
              <SortHeader
                field="err"
                label="5xx"
                align="right"
                sortField={sortField}
                sortDir={sortDir}
                onSort={toggleSort}
                className="px-2 w-[80px]"
              />
              <th className="pl-2 pr-4 w-[100px]" aria-label="Actions" />
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.04]">
            {sorted.map((row) => (
              <Row
                key={row.name}
                data={row}
                onDelete={onDelete}
                selectable={supportsBulk}
                selected={selected.has(row.name)}
                onToggleSelect={() => toggleSelect(row.name)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SortHeader({
  field,
  label,
  sortField,
  sortDir,
  onSort,
  align = 'left',
  className = '',
}: {
  field: SortField;
  label: string;
  sortField: SortField;
  sortDir: SortDir;
  onSort: (f: SortField) => void;
  align?: 'left' | 'right';
  className?: string;
}) {
  const active = sortField === field;
  return (
    <th className={`py-2.5 ${className}`}>
      <button
        type="button"
        onClick={() => onSort(field)}
        aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={`inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider transition-colors group ${
          active ? 'text-text' : 'text-text-tertiary hover:text-text-secondary'
        } ${align === 'right' ? 'flex-row-reverse' : ''}`}
      >
        <span>{label}</span>
        {/* Always show a sort affordance — gives users a visible target.
            Active column = ▲ or ▼; inactive = subdued ↕ that brightens on hover. */}
        <span
          aria-hidden
          className={`text-[9px] tabular-nums ${
            active ? 'text-accent' : 'text-text-tertiary/40 group-hover:text-text-tertiary'
          }`}
        >
          {active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  );
}

function Row({
  data,
  onDelete,
  selectable,
  selected,
  onToggleSelect,
}: {
  data: AppCardData;
  onDelete: (name: string) => void;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const cpuColor =
    data.cpuPercent >= 90
      ? 'text-danger'
      : data.cpuPercent >= 70
        ? 'text-warning'
        : 'text-text-secondary';
  const memColor =
    data.memPercent >= 90
      ? 'text-danger'
      : data.memPercent >= 70
        ? 'text-warning'
        : 'text-text-secondary';
  const p95Color =
    data.p95 > 5000 ? 'text-danger' : data.p95 > 1000 ? 'text-warning' : 'text-text-secondary';
  const errColor =
    data.errPct > 5 ? 'text-danger' : data.errPct > 1 ? 'text-warning' : 'text-text-secondary';

  const sparkColor =
    data.severity === 'down'
      ? 'var(--color-danger)'
      : data.severity === 'degraded'
        ? 'var(--color-warning)'
        : 'var(--color-accent)';

  return (
    <tr
      className={`group relative cursor-pointer transition-colors hover:bg-bg-hover/60 hover:shadow-[inset_2px_0_0_0_hsl(266_90%_66%/0.55)] ${
        selected ? 'bg-accent/[0.06]' : ''
      }`}
    >
      {/* Selection checkbox — rendered only when the parent wired bulk
          handlers. Click handling lives on the cell so the row's link
          doesn't swallow the event. */}
      {selectable && (
        <td
          className="pl-4 pr-1 py-3 align-middle"
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          <input
            type="checkbox"
            checked={selected ?? false}
            onChange={() => onToggleSelect?.()}
            aria-label={`Select ${data.name}`}
            className="accent-accent cursor-pointer"
          />
        </td>
      )}
      {/* Status */}
      <td className="pl-4 pr-2 py-3">
        <Link to={`/dashboard/${data.name}`} className="flex items-center gap-2">
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${SEVERITY_DOT[data.severity]}`}
            aria-hidden
          />
          <span className="text-xs text-text-secondary">{SEVERITY_LABEL[data.severity]}</span>
          {data.crashLooping && (
            <span
              className="badge badge-warning text-[10px] px-1.5 py-0"
              title="Container has restarted 3+ times in the last 5 minutes"
            >
              restart loop
            </span>
          )}
        </Link>
      </td>

      {/* Name + URL */}
      <td className="px-2 py-3 min-w-0">
        <Link to={`/dashboard/${data.name}`} className="block min-w-0">
          <div className="font-medium text-text truncate">{data.name}</div>
          <div className="text-[11px] font-mono text-text-tertiary truncate">{data.name}.local</div>
        </Link>
      </td>

      {/* RPS + sparkline */}
      <td className="px-2 py-3 text-right">
        <Link to={`/dashboard/${data.name}`} className="flex items-center justify-end gap-3">
          {data.rpsHistory.length > 1 && (
            <span className="w-14 -my-2 inline-block">
              <MiniSparkline
                data={data.rpsHistory}
                color={sparkColor}
                height={20}
                width={56}
                gradient={sparkColor === 'var(--color-accent)'}
              />
            </span>
          )}
          <span className="font-mono tabular-nums text-text-secondary text-sm w-12 inline-block">
            {data.rps < 1 ? data.rps.toFixed(2) : data.rps.toFixed(1)}
          </span>
        </Link>
      </td>

      {/* CPU */}
      <td className="px-2 py-3 text-right">
        <Link
          to={`/dashboard/${data.name}`}
          className={`font-mono tabular-nums text-sm ${cpuColor}`}
        >
          {data.cpuPercent.toFixed(1)}%
        </Link>
      </td>

      {/* Memory */}
      <td className="px-2 py-3 text-right">
        <Link
          to={`/dashboard/${data.name}`}
          className={`font-mono tabular-nums text-sm ${memColor}`}
        >
          {formatBytes(data.memUsageBytes)}
          {data.memLimitBytes > 0 && (
            <span className="text-text-tertiary"> · {data.memPercent.toFixed(0)}%</span>
          )}
        </Link>
      </td>

      {/* p95 */}
      <td className="px-2 py-3 text-right">
        <Link
          to={`/dashboard/${data.name}`}
          className={`font-mono tabular-nums text-sm ${p95Color}`}
        >
          {data.p95 > 0 ? `${Math.round(data.p95)}ms` : '—'}
        </Link>
      </td>

      {/* Error rate */}
      <td className="px-2 py-3 text-right">
        <Link
          to={`/dashboard/${data.name}`}
          className={`font-mono tabular-nums text-sm ${errColor}`}
        >
          {data.errPct.toFixed(1)}%
        </Link>
      </td>

      {/* Row actions — always visible at low opacity, brighten on row hover.
          Previously hidden until hover, which made them invisible to
          keyboard tabbing and to anyone scanning the table for actions. */}
      <td className="pl-2 pr-4 py-3 text-right">
        <div className="flex items-center justify-end gap-1 opacity-40 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <a
            href={appUrl(data.name)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-text-tertiary hover:text-text px-2 py-1 rounded text-xs"
            title="Open app"
          >
            Open
          </a>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDelete(data.name);
            }}
            className="text-text-tertiary hover:text-danger px-2 py-1 rounded text-xs"
            title="Delete deployment"
          >
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}
