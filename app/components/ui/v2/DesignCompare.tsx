'use client';
import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  afterAt,
  compareKey,
  savedCompareMode,
  saveCompareMode,
  subscribeCompareMode,
} from './design-compare';
import { Seg } from './Seg';
import './design-compare.css';

/** Identically sized, opaque versions supplied by the board renderer. */
export function DesignCompare({
  before,
  after,
  added = false,
  removed = false,
  children,
}: {
  before: ReactNode;
  after: ReactNode;
  added?: boolean;
  removed?: boolean;
  children?: ReactNode;
}) {
  const mode = useSyncExternalStore(
    subscribeCompareMode,
    savedCompareMode,
    () => 'slider' as const,
  );
  const [percent, setPercent] = useState(50);
  const [opacity, setOpacity] = useState(40);
  const surface = useRef<HTMLDivElement>(null);
  const single = added || removed;
  const move = (x: number) => {
    const rect = surface.current?.getBoundingClientRect();
    if (rect) setPercent(afterAt(x, rect.left, rect.width));
  };
  return (
    <div className="dl-design-compare">
      <div className="dl-design-compare-bar">
        {children}
        {single ? (
          <span className="dl-tag">{removed ? 'Removed' : 'New board'}</span>
        ) : (
          <>
            <Seg
              label="Comparison mode"
              value={mode}
              options={[
                { value: 'slider', label: 'Slider' },
                { value: 'onion', label: 'Onion skin' },
              ]}
              onChange={(value) => saveCompareMode(value === 'onion' ? 'onion' : 'slider')}
            />
            {mode === 'slider' && <span className="dl-meta">Drag the divider to compare</span>}
          </>
        )}
      </div>
      <div className="dl-design-compare-image" ref={surface}>
        <div aria-hidden="true">{removed ? before : added ? after : before}</div>
        {!single && (
          <div
            className="dl-design-compare-after"
            aria-hidden="true"
            style={
              mode === 'slider'
                ? { clipPath: `inset(0 0 0 ${100 - percent}%)` }
                : { opacity: opacity / 100 }
            }
          >
            {after}
          </div>
        )}
        {!single && mode === 'slider' && (
          <>
            <span className="dl-design-compare-label before">Before · main</span>
            <span className="dl-design-compare-label after">After · this branch</span>
            <div
              className="dl-design-compare-handle"
              role="slider"
              tabIndex={0}
              aria-label="Compare"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-valuetext={`${percent}% After`}
              style={{ left: `${100 - percent}%` }}
              onKeyDown={(event) => {
                const next = compareKey(percent, event.key);
                if (next !== undefined) {
                  event.preventDefault();
                  setPercent(next);
                }
              }}
              onPointerDown={(event) => {
                if (!event.isPrimary || event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
                move(event.clientX);
              }}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) move(event.clientX);
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  event.currentTarget.releasePointerCapture(event.pointerId);
              }}
            >
              <span aria-hidden="true">‹ ›</span>
            </div>
          </>
        )}
      </div>
      {single && (
        <span className="dl-meta">{removed ? 'Before' : 'After only · no previous version'}</span>
      )}
      {!single && mode === 'onion' && (
        <label className="dl-design-compare-opacity">
          <span>
            After opacity <span>{opacity}%</span>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={opacity}
            aria-label="After opacity"
            aria-valuetext={`${opacity}% After`}
            onChange={(event) => setOpacity(Number(event.target.value))}
          />
          <span className="dl-meta">
            0% Before <span>100% After</span>
          </span>
        </label>
      )}
    </div>
  );
}
