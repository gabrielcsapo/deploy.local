'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui';
import { boardName, type Canvas } from './model';

type Spot = { to: string; x: number; y: number; w: number; h: number; sidebar: boolean };

/**
 * Play: a page's boards full screen, one at a time, following their links. Back and the trail
 * retrace the way; clicking where there is no link lights the links up.
 */
export function Play({
  canvas,
  start,
  src,
  onClose,
}: {
  canvas: Canvas;
  start: string;
  /** Where a board's file is served. */
  src: (board: string) => string;
  onClose: () => void;
}) {
  const [trail, setTrail] = useState([start]);
  const board = trail[trail.length - 1];
  const placed = canvas.boards[board];
  const phone = (placed?.w ?? 1440) <= 500;
  const widths = phone ? [placed.w] : [1440, 700, 390];
  const [chosen, setChosen] = useState(0);
  const width = widths.includes(chosen) ? chosen : widths[0];
  const height = placed?.h ?? 900;
  const [spots, setSpots] = useState<Spot[]>([]);
  const [lit, setLit] = useState(true);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [touch, setTouch] = useState(false);
  useEffect(() => setTouch(window.matchMedia('(pointer: coarse)').matches), []);
  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setStage({ w: entry.contentRect.width, h: entry.contentRect.height }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // The board fits the stage, never larger than itself.
  // Room is kept below it for the hint.
  const scale = stage.w ? Math.min(1, (stage.w - 32) / width, (stage.h - 84) / height) : 0;

  const go = useCallback((to: string) => setTrail((current) => [...current, to]), []);
  const back = useCallback(
    () => setTrail((current) => (current.length > 1 ? current.slice(0, -1) : current)),
    [],
  );
  const restart = useCallback(() => setTrail([start]), [start]);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowLeft' || event.key === 'Backspace') back();
      else if (event.key === 'r' || event.key === 'R') restart();
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [back, restart, onClose]);
  // Each board shows where you can go for a moment, as a click where there's no link does.
  const flash = useCallback(() => {
    setLit(true);
    const timer = window.setTimeout(() => setLit(false), 1400);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => flash(), [board, width, flash]);

  // The links on the board on screen: layers whose link names a board on the canvas.
  const measure = () => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    setSpots(
      [...doc.querySelectorAll<HTMLElement>('[href]')]
        .map((element) => {
          const to = element.getAttribute('href') ?? '';
          const box = element.getBoundingClientRect();
          // The app's sidebar repeats on every board: its links work but stay unlit.
          const sidebar = Boolean(element.closest('.dl-side'));
          return { to, x: box.left, y: box.top, w: box.width, h: box.height, sidebar };
        })
        .filter((spot) => spot.w > 0 && spot.to !== board && canvas.boards[spot.to]),
    );
  };

  const swipe = useRef<{ x: number; y: number } | null>(null);
  return (
    <div className="dz-play" role="dialog" aria-label={`Play: ${boardName(board)}`}>
      <header className="dz-play-top">
        <button
          type="button"
          className="dz-play-btn quiet"
          disabled={trail.length < 2}
          onClick={back}
          aria-label="Back"
        >
          <Icon name="back" size={16} />
          <span className="dz-lbl">Back</span>
        </button>
        <nav className="dz-play-trail" aria-label="Where you have been">
          {trail.map((step, index) =>
            index === trail.length - 1 ? (
              <b key={index}>{boardName(step)}</b>
            ) : (
              <span key={index}>
                <button type="button" onClick={() => setTrail(trail.slice(0, index + 1))}>
                  {boardName(step)}
                </button>
                <Icon name="chevron" size={12} />
              </span>
            ),
          )}
        </nav>
        <span className="dz-play-grow" />
        {widths.length > 1 && (
          <div className="dz-play-seg" role="radiogroup" aria-label="Width">
            {widths.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={value === width}
                className={value === width ? 'on' : ''}
                onClick={() => setChosen(value)}
              >
                {value}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="dz-play-btn quiet" onClick={restart} aria-label="Restart">
          <Icon name="undo" size={15} />
          <span className="dz-lbl">Restart</span>
        </button>
        <button type="button" className="dz-play-btn" onClick={onClose}>
          <Icon name="close" size={15} />
          {touch ? 'Done' : 'Exit'}
          {!touch && <kbd>Esc</kbd>}
        </button>
      </header>
      <main className="dz-play-stage" ref={stageRef}>
        {placed && scale > 0 && (
          <div
            className="dz-play-board"
            style={{ width: width * scale, height: height * scale }}
            onPointerDown={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              if (event.pointerType === 'touch' && event.clientX - box.left < 24)
                swipe.current = { x: event.clientX, y: event.clientY };
            }}
            onPointerUp={(event) => {
              const from = swipe.current;
              swipe.current = null;
              if (from && event.clientX - from.x > 80 && Math.abs(event.clientY - from.y) < 60)
                return back();
              const box = event.currentTarget.getBoundingClientRect();
              const x = (event.clientX - box.left) / scale;
              const y = (event.clientY - box.top) / scale;
              const hit = spots.find(
                (spot) =>
                  x >= spot.x && x <= spot.x + spot.w && y >= spot.y && y <= spot.y + spot.h,
              );
              if (hit) go(hit.to);
              else flash();
            }}
          >
            <iframe
              key={`${board}:${width}`}
              ref={frame}
              title={boardName(board)}
              sandbox="allow-same-origin"
              src={src(board)}
              width={width}
              height={height}
              tabIndex={-1}
              style={{ transform: `scale(${scale})` }}
              onLoad={measure}
            />
            <div
              className={`dz-play-spots${lit ? ' lit' : ''}`}
              style={{ width, height, transform: `scale(${scale})` }}
              aria-hidden="true"
            >
              {spots
                .filter((spot) => !spot.sidebar)
                .map((spot, index) => (
                  <i
                    key={index}
                    style={{ left: spot.x, top: spot.y, width: spot.w, height: spot.h }}
                  />
                ))}
            </div>
          </div>
        )}
        <div className="dz-play-hint">
          {touch ? (
            <>
              <span>Tap a lit spot to go there</span>
              <span className="k">Swipe from the left edge to go back</span>
            </>
          ) : (
            <>
              <span>Links light up when you click where there isn’t one</span>
              <span className="k">
                <kbd>←</kbd> Back
              </span>
              <span className="k">
                <kbd>R</kbd> Restart
              </span>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
