'use client';

import { useMemo, type ReactNode } from 'react';

function formatDayHeader(date: Date, todayStr: string, yesterdayStr: string): string {
  const dayStr = date.toDateString();
  if (dayStr === todayStr) return 'Today';
  if (dayStr === yesterdayStr) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });
}

export interface DayGroupItem<T> {
  /** Either a Date or a millisecond timestamp or an ISO string */
  at: Date | number | string;
  item: T;
}

export function groupByDay<T>(items: DayGroupItem<T>[]): Map<string, DayGroupItem<T>[]> {
  const groups = new Map<string, DayGroupItem<T>[]>();
  for (const entry of items) {
    const d = entry.at instanceof Date ? entry.at : new Date(entry.at);
    const key = d.toDateString();
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }
  return groups;
}

export function DayGroup<T>({
  items,
  renderItem,
  className = '',
}: {
  items: DayGroupItem<T>[];
  renderItem: (item: T, at: Date) => ReactNode;
  className?: string;
}) {
  const todayStr = new Date().toDateString();
  const yesterdayStr = new Date(Date.now() - 24 * 60 * 60 * 1000).toDateString();

  const groups = useMemo(() => groupByDay(items), [items]);
  // Preserve insertion order (which matches the caller's sort order)
  const orderedKeys = Array.from(groups.keys());

  return (
    <div className={`space-y-4 ${className}`}>
      {orderedKeys.map((dayKey) => {
        const dayItems = groups.get(dayKey)!;
        const headerLabel = formatDayHeader(new Date(dayKey), todayStr, yesterdayStr);
        return (
          <section key={dayKey}>
            <h3 className="sticky top-0 z-10 bg-bg/95 backdrop-blur-sm py-1.5 mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary border-b border-border">
              {headerLabel}{' '}
              <span className="text-text-tertiary/60 ml-1 normal-case font-normal tracking-normal">
                {dayItems.length}
              </span>
            </h3>
            <ul className="space-y-1.5">
              {dayItems.map((entry, i) => {
                const d = entry.at instanceof Date ? entry.at : new Date(entry.at);
                return <li key={i}>{renderItem(entry.item, d)}</li>;
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
