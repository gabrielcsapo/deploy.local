'use client';
import { useId, useState } from 'react';
import { Seg } from '@/components/ui';
import type { DesignCheckBoard } from '../../../../../shared/v2/contracts';
import './build-check.css';

/** Both images use the reported viewport; the board always comes from the approved commit. */
export function BuildComparison({
  projectId,
  commit,
  board,
  width: initialWidth,
  captures = [],
}: {
  projectId: string;
  commit: string;
  board: DesignCheckBoard;
  width?: number;
  captures?: { image: string; width: number; height: number }[];
}) {
  const [width, setWidth] = useState(initialWidth ?? board.widths[0]);
  const [position, setPosition] = useState(50);
  const slider = useId();
  const capture = captures.find((entry) => entry.width === width);
  const widths = [
    ...new Set([...board.widths, initialWidth].filter((value): value is number => !!value)),
  ];
  const source = `/api/projects/${encodeURIComponent(projectId)}/design/render?ref=${encodeURIComponent(commit)}&board=${encodeURIComponent(board.file)}&width=${width}&height=${board.height}`;
  return (
    <>
      <div className="dl-setting">
        <span className="dl-label">{board.title}</span>
        <Seg
          label="Width"
          value={String(width)}
          options={widths.map((value) => ({ value: String(value), label: String(value) }))}
          onChange={(value) => setWidth(Number(value))}
        />
      </div>
      <div className="dl-build-comparison">
        <section className="dl-section">
          <h2 className="dl-section-title dl-build-label before">Approved design</h2>
          <img src={source} alt={`${board.title}, approved design at ${width} px`} />
        </section>
        {capture && (
          <>
            <section
              className="dl-section dl-build-after"
              style={{ clipPath: `inset(0 0 0 ${position}%)` }}
            >
              <h2 className="dl-section-title dl-build-label after">The app</h2>
              <img src={capture.image} alt={`The app at ${width} px`} />
            </section>
            <span className="dl-build-divider" style={{ left: `${position}%` }} aria-hidden="true">
              <span className="dl-chip">↔</span>
            </span>
          </>
        )}
      </div>
      {capture && (
        <>
          <label className="dl-label" htmlFor={slider}>
            Drag to compare the design and the app
          </label>
          <input
            className="dl-field"
            id={slider}
            type="range"
            min={0}
            max={100}
            value={position}
            onChange={(event) => setPosition(Number(event.target.value))}
            aria-label="Comparison position"
          />
        </>
      )}
    </>
  );
}
