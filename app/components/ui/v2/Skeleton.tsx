'use client';
import { useEffect, useState } from 'react';
import { type ComponentState, Icon } from './shared';
export function Skeleton({
  rows = 3,
  label = 'Loading',
  slowLabel = 'Taking longer than usual',
  disabled,
}: ComponentState & { rows?: number; label?: string; slowLabel?: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 10000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div role="status" aria-busy="true" aria-label={label} data-disabled={disabled || undefined}>
      <div className="dl-group" aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <div className="dl-item" key={index}>
            <span className="dl-skel box" />
            <span className="dl-t" style={{ gap: 6 }}>
              <span className="dl-skel" style={{ width: `${[38, 52, 30][index % 3]}%` }} />
              <span
                className="dl-skel"
                style={{ width: `${[62, 44, 56][index % 3]}%`, height: 8 }}
              />
            </span>
            <span className="dl-skel" style={{ width: 56 }} />
          </div>
        ))}
      </div>
      {slow && slowLabel && (
        <div className="dl-notice">
          <Icon name="running" className="dl-run" />
          {slowLabel}
        </div>
      )}
    </div>
  );
}
