'use client';

import { useEffect, useState } from 'react';

export type TimeRangePreset = '1h' | '6h' | '24h' | '7d' | '30d' | 'custom';

export interface TimeRangeValue {
  preset: TimeRangePreset;
  fromMs: number;
  toMs: number;
}

const PRESETS: { value: Exclude<TimeRangePreset, 'custom'>; label: string; ms: number }[] = [
  { value: '1h', label: '1h', ms: 60 * 60 * 1000 },
  { value: '6h', label: '6h', ms: 6 * 60 * 60 * 1000 },
  { value: '24h', label: '24h', ms: 24 * 60 * 60 * 1000 },
  { value: '7d', label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
];

export function resolvePreset(
  preset: Exclude<TimeRangePreset, 'custom'>,
  now = Date.now(),
): TimeRangeValue {
  const found = PRESETS.find((p) => p.value === preset)!;
  return { preset, fromMs: now - found.ms, toMs: now };
}

export function TimeRange({
  value,
  onChange,
  className = '',
}: {
  value: TimeRangeValue;
  onChange: (next: TimeRangeValue) => void;
  className?: string;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState(() => toInputDate(value.fromMs));
  const [customTo, setCustomTo] = useState(() => toInputDate(value.toMs));

  useEffect(() => {
    if (value.preset !== 'custom') {
      setCustomFrom(toInputDate(value.fromMs));
      setCustomTo(toInputDate(value.toMs));
    }
  }, [value.preset, value.fromMs, value.toMs]);

  function pick(preset: Exclude<TimeRangePreset, 'custom'>) {
    onChange(resolvePreset(preset));
  }

  function applyCustom() {
    const fromMs = new Date(customFrom).getTime();
    const toMs = new Date(customTo).getTime();
    if (Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs) {
      onChange({ preset: 'custom', fromMs, toMs });
      setCustomOpen(false);
    }
  }

  return (
    <div
      className={`flex flex-wrap items-center gap-1.5 ${className}`}
      title="Time range applies to every chart and metric on this page"
    >
      {/* Mobile: dropdown */}
      <label className="sm:hidden flex-1 min-w-0">
        <span className="sr-only">Time range</span>
        <select
          value={value.preset === 'custom' ? 'custom' : value.preset}
          onChange={(e) => {
            const v = e.target.value as TimeRangePreset;
            if (v === 'custom') setCustomOpen(true);
            else pick(v as Exclude<TimeRangePreset, 'custom'>);
          }}
          className="w-full rounded-lg border border-border bg-bg-surface px-3 py-2 text-sm text-text"
        >
          {PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              Last {p.label}
            </option>
          ))}
          <option value="custom">Custom range…</option>
        </select>
      </label>

      {/* Desktop: pill row */}
      <div className="hidden sm:flex items-center gap-1">
        {PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => pick(p.value)}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-all min-h-[32px] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              value.preset === p.value
                ? 'text-white shadow-[0_0_0_1px_hsl(266_90%_66%/0.35),0_4px_14px_-4px_hsl(266_90%_50%/0.5)]'
                : 'bg-bg-surface text-text-secondary hover:bg-bg-hover'
            }`}
            style={value.preset === p.value ? { background: 'var(--gradient-nav)' } : undefined}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setCustomOpen((v) => !v)}
          className={`px-2.5 py-1 text-xs font-medium rounded-md transition-all min-h-[32px] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            value.preset === 'custom'
              ? 'text-white shadow-[0_0_0_1px_hsl(266_90%_66%/0.35),0_4px_14px_-4px_hsl(266_90%_50%/0.5)]'
              : 'bg-bg-surface text-text-secondary hover:bg-bg-hover'
          }`}
          style={value.preset === 'custom' ? { background: 'var(--gradient-nav)' } : undefined}
        >
          Custom
        </button>
      </div>

      {customOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center px-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setCustomOpen(false);
          }}
        >
          <div className="card p-5 max-w-sm w-full space-y-3">
            <p className="text-sm font-semibold">Custom time range</p>
            <label className="block text-xs text-text-secondary">
              From
              <input
                type="datetime-local"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-xs text-text-secondary">
              To
              <input
                type="datetime-local"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm"
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCustomOpen(false)}
                className="btn btn-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={applyCustom}
                className="btn btn-sm btn-primary"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function toInputDate(ms: number): string {
  const d = new Date(ms);
  // YYYY-MM-DDTHH:MM in local time
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}
