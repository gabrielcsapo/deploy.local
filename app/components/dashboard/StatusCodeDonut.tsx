'use client';

export interface StatusCounts {
  s2xx?: number;
  s3xx?: number;
  s4xx?: number;
  s5xx?: number;
}

const SLICES: Array<{
  key: keyof StatusCounts;
  label: string;
  color: string;
  filter: '2xx' | '3xx' | '4xx' | '5xx';
}> = [
  { key: 's2xx', label: '2xx', color: 'var(--color-success)', filter: '2xx' },
  { key: 's3xx', label: '3xx', color: 'var(--color-accent)', filter: '3xx' },
  { key: 's4xx', label: '4xx', color: 'var(--color-warning)', filter: '4xx' },
  { key: 's5xx', label: '5xx', color: 'var(--color-danger)', filter: '5xx' },
];

export function StatusCodeDonut({
  counts,
  activeFilter,
  onClickClass,
}: {
  counts: StatusCounts;
  activeFilter?: '2xx' | '3xx' | '4xx' | '5xx' | null;
  onClickClass?: (cls: '2xx' | '3xx' | '4xx' | '5xx') => void;
}) {
  const total =
    (counts.s2xx ?? 0) + (counts.s3xx ?? 0) + (counts.s4xx ?? 0) + (counts.s5xx ?? 0);
  const interactive = !!onClickClass;
  const size = 96;
  const stroke = 14;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;

  return (
    <div className="card p-3 sm:p-4">
      <p className="text-xs text-text-tertiary mb-3">Status Codes</p>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
        <div className="relative shrink-0 self-center" style={{ width: size, height: size }}>
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke="var(--color-bg-hover)"
              strokeWidth={stroke}
            />
            {total > 0 &&
              SLICES.map((slice) => {
                const value = counts[slice.key] ?? 0;
                if (!value) return null;
                const portion = value / total;
                const dash = portion * c;
                const circle = (
                  <circle
                    key={slice.key}
                    cx={size / 2}
                    cy={size / 2}
                    r={r}
                    fill="none"
                    stroke={slice.color}
                    strokeWidth={stroke}
                    strokeDasharray={`${dash} ${c}`}
                    strokeDashoffset={-offset}
                    opacity={
                      activeFilter && activeFilter !== slice.filter ? 0.25 : 1
                    }
                    className="transition-opacity"
                  />
                );
                offset += dash;
                return circle;
              })}
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <p className="text-base font-mono font-semibold leading-none">
              {total.toLocaleString()}
            </p>
            <p className="text-[10px] text-text-tertiary mt-0.5">total</p>
          </div>
        </div>
        <ul className="flex-1 grid grid-cols-2 sm:grid-cols-1 gap-1 min-w-0">
          {SLICES.map((slice) => {
            const value = counts[slice.key] ?? 0;
            const pct = total > 0 ? (value / total) * 100 : 0;
            const isActive = activeFilter === slice.filter;
            const Comp = interactive ? 'button' : 'div';
            return (
              <li key={slice.key}>
                <Comp
                  type={interactive ? 'button' : undefined}
                  onClick={interactive ? () => onClickClass!(slice.filter) : undefined}
                  className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded text-left min-h-[28px] ${
                    interactive ? 'hover:bg-bg-hover cursor-pointer' : ''
                  } ${isActive ? 'bg-bg-hover ring-1 ring-accent/30' : ''}`}
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span
                      className="inline-block w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: slice.color }}
                      aria-hidden
                    />
                    <span className="text-xs font-mono">{slice.label}</span>
                  </span>
                  <span className="text-xs font-mono text-text-secondary tabular-nums">
                    {value.toLocaleString()}
                    {value > 0 && (
                      <span className="text-text-tertiary ml-1">({pct.toFixed(0)}%)</span>
                    )}
                  </span>
                </Comp>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
