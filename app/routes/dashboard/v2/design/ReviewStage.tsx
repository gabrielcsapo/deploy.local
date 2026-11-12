'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Skeleton, Action } from '@/components/ui';
import {
  savedCompareMode,
  saveCompareMode,
  subscribeCompareMode,
} from '@/components/ui/v2/design-compare';
import {
  reviewAreas,
  reviewDrawingPath,
  reviewNotePosition,
} from '../../../../../shared/v2/design-review';
import type {
  DesignRect,
  DesignReviewDrawing,
  DesignReviewPin,
  DesignReviewScreen,
} from '../../../../../shared/v2/contracts';

export type ReviewDraft = {
  id?: string;
  text: string;
  board: string;
  width: number;
  revision: string;
  x: number;
  y: number;
  layer?: string;
  offset?: { x: number; y: number };
  area?: DesignRect;
  drawing?: DesignReviewDrawing;
};
type Tool = 'select' | 'pin' | 'area' | 'draw';
const tools: { tool: Tool; label: string; path: string }[] = [
  { tool: 'select', label: 'Select', path: 'M5 3l14 8-6 2-2 6z' },
  {
    tool: 'pin',
    label: 'Pin a point',
    path: 'M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z M14.5 10a2.5 2.5 0 1 0-5 0a2.5 2.5 0 0 0 5 0',
  },
  { tool: 'area', label: 'Mark an area', path: 'M4 5h16v14H4z' },
  { tool: 'draw', label: 'Draw', path: 'm15 4 5 5M4 20l5-1L20 8a2.1 2.1 0 0 0-5-5L4 15z' },
];
export function ReviewStage({
  api,
  board,
  pins,
  draft,
  setDraft,
  save,
  busy,
  editable,
  ready,
}: {
  api: string;
  board: DesignReviewScreen;
  pins: DesignReviewPin[];
  draft: ReviewDraft | null;
  setDraft: (draft: ReviewDraft | null) => void;
  save: () => void;
  busy: boolean;
  editable: boolean;
  ready: (file: string) => void;
}) {
  const stage = useRef<HTMLDivElement>(null),
    surface = useRef<HTMLDivElement>(null);
  const before = useRef<HTMLIFrameElement>(null),
    after = useRef<HTMLIFrameElement>(null);
  const [available, setAvailable] = useState(1116),
    [chosen, setChosen] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false),
    [tool, setTool] = useState<Tool>('select');
  const [amount, setAmount] = useState(board.resolution ? 50 : 100),
    [mode, setMode] = useState(() => savedCompareMode('onion'));
  const [boxes, setBoxes] = useState<Record<string, DesignRect>>({});
  const [oldBoxes, setOldBoxes] = useState<Record<string, DesignRect>>({});
  const [loaded, setLoaded] = useState({ before: false, after: false });
  const [gesture, setGesture] = useState<{
    start: { x: number; y: number };
    points: { x: number; y: number }[];
  } | null>(null);
  const width = Math.max(
    320,
    Math.min(chosen ?? (board.w <= 500 ? board.w : available), available, 2560),
  );
  useEffect(() => subscribeCompareMode(() => setMode(savedCompareMode('onion'))), []);
  useLayoutEffect(() => {
    const element = stage.current!;
    const observer = new ResizeObserver(() =>
      setAvailable(
        Math.max(
          320,
          element.clientWidth -
            parseFloat(getComputedStyle(element).paddingLeft) -
            parseFloat(getComputedStyle(element).paddingRight),
        ),
      ),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const measure = useCallback(() => {
    const read = (frame: HTMLIFrameElement | null) => {
      const result: Record<string, DesignRect> = {};
      frame?.contentDocument?.querySelectorAll<HTMLElement>('[data-layer]').forEach((element) => {
        const rect = element.getBoundingClientRect();
        if (
          rect.width &&
          rect.height &&
          frame.contentWindow?.getComputedStyle(element).visibility !== 'hidden'
        )
          result[element.dataset.layer!] = { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
      });
      return result;
    };
    setBoxes(read(after.current));
    setOldBoxes(read(before.current));
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [width, measure]);
  useEffect(() => {
    if ((board.added || loaded.before) && (board.removed || loaded.after)) ready(board.file);
  }, [board, loaded, ready]);
  const load = (side: 'before' | 'after') => {
    const frame = side === 'before' ? before.current : after.current;
    const doc = frame?.contentDocument;
    doc?.addEventListener('click', (event) => event.preventDefault());
    doc?.addEventListener('keydown', (event) => {
      if (['Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: event.key }));
      }
    });
    doc?.addEventListener(
      'scroll',
      (event) => {
        const root = event.target === doc;
        const source = (root ? doc.scrollingElement : event.target) as HTMLElement | null;
        const other = (side === 'before' ? after.current : before.current)?.contentDocument;
        const peer = root
          ? other?.scrollingElement
          : source?.dataset?.layer
            ? other?.querySelector<HTMLElement>(
                `[data-layer="${CSS.escape(source.dataset.layer)}"]`,
              )
            : null;
        if (peer && source) {
          if (peer.scrollTop !== source.scrollTop) peer.scrollTop = source.scrollTop;
          if (peer.scrollLeft !== source.scrollLeft) peer.scrollLeft = source.scrollLeft;
        }
        measure();
      },
      true,
    );
    void doc?.fonts.ready.then(measure);
    setLoaded((value) => ({ ...value, [side]: true }));
    measure();
  };
  const position = (event: { clientX: number; clientY: number }) => {
    const rect = surface.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(board.h, event.clientY - rect.top)),
    };
  };
  const activeBoxes = board.removed || amount === 0 ? oldBoxes : boxes;
  const anchor = (point: { x: number; y: number }) => {
    const hit = Object.entries(activeBoxes)
      .filter(
        ([, r]) => point.x >= r.x && point.y >= r.y && point.x <= r.x + r.w && point.y <= r.y + r.h,
      )
      .sort((a, b) => a[1].w * a[1].h - b[1].w * b[1].h)[0];
    return hit
      ? {
          layer: hit[0],
          offset: { x: (point.x - hit[1].x) / hit[1].w, y: (point.y - hit[1].y) / hit[1].h },
        }
      : {};
  };
  const beginNote = (point: { x: number; y: number }, extra: Partial<ReviewDraft> = {}) => {
    setDraft({
      board: board.file,
      width: Math.round(width),
      revision: board.removed || amount === 0 ? board.before : board.after,
      ...point,
      ...anchor(point),
      text: '',
      ...extra,
    });
  };
  const areaFor = (points: { x: number; y: number }[]) => {
    const x = Math.min(...points.map((p) => p.x)),
      y = Math.min(...points.map((p) => p.y));
    return {
      x,
      y,
      w: Math.max(...points.map((p) => p.x)) - x,
      h: Math.max(...points.map((p) => p.y)) - y,
    };
  };
  const drawingFor = (points: { x: number; y: number }[]): DesignReviewDrawing => ({
    side: board.removed || amount === 0 ? 'before' : 'after',
    nativeWidth: Math.round(width),
    nativeHeight: board.h,
    anchor: { x: points[0].x / width, y: points[0].y / board.h },
    weight: 3,
    strokes: [points.slice(0, 4096).map((p) => ({ x: p.x / width, y: p.y / board.h }))],
  });
  const draftPoint = draft && reviewNotePosition(draft, activeBoxes);
  const draftBounds =
    draft?.area ??
    (draft?.drawing
      ? areaFor(
          draft.drawing.strokes.flat().map((p) => ({
            x: p.x * draft.drawing!.nativeWidth,
            y: p.y * draft.drawing!.nativeHeight,
          })),
        )
      : null);
  const resizeArea = (corner: string, point: { x: number; y: number }) => {
    if (!draft?.area || !draftPoint) return;
    const a = draft.area,
      p = { x: point.x - draftPoint.x + draft.x, y: point.y - draftPoint.y + draft.y };
    const left = corner.includes('l') ? Math.max(0, Math.min(a.x + a.w - 1, p.x)) : a.x;
    const right = corner.includes('r') ? Math.min(draft.width, Math.max(a.x + 1, p.x)) : a.x + a.w;
    const top = corner.includes('t') ? Math.max(0, Math.min(a.y + a.h - 1, p.y)) : a.y;
    const bottom = corner.includes('b') ? Math.min(board.h, Math.max(a.y + 1, p.y)) : a.y + a.h;
    setDraft({ ...draft, area: { x: left, y: top, w: right - left, h: bottom - top } });
  };

  const marks = [...pins, ...(draft && !draft.id ? [{ ...draft, id: 'draft' }] : [])];
  const area = gesture && tool === 'area' ? areaFor([gesture.start, gesture.points.at(-1)!]) : null;
  const readyFrames = (board.added || loaded.before) && (board.removed || loaded.after);
  return (
    <div className="dl-rv-stage" ref={stage}>
      <div className="dl-rv-design">
        <div className="dl-rv-frame" style={{ width }}>
          <div className="dl-rv-live-scroll">
            <div className="dl-rv-live-surface" ref={surface} style={{ height: board.h }}>
              {!board.removed && (
                <iframe
                  ref={after}
                  title={`${board.title} · ${board.resolution ? 'This proposal' : 'New'}`}
                  sandbox="allow-same-origin"
                  src={`${api}/files/${board.after}/boards/${encodeURIComponent(board.file)}`}
                  onLoad={() => load('after')}
                  width={width}
                  height={board.h}
                />
              )}
              {!board.added && (
                <iframe
                  ref={before}
                  title={`${board.title} · ${board.resolution ? 'Main' : 'Old'}`}
                  sandbox="allow-same-origin"
                  src={`${api}/files/${board.before}/boards/${encodeURIComponent(board.file)}`}
                  onLoad={() => load('before')}
                  width={width}
                  height={board.h}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    opacity: board.removed || mode === 'slider' ? 1 : 1 - amount / 100,
                    clipPath:
                      !board.removed && mode === 'slider' ? `inset(0 ${amount}% 0 0)` : undefined,
                    pointerEvents: board.removed || amount === 0 ? 'auto' : 'none',
                  }}
                />
              )}
              <div className="dl-rv-outlines" aria-hidden="true">
                {reviewAreas(board.changes, oldBoxes, boxes, width, board.h).map((change) => {
                  const r = change.after ?? change.before;
                  return (
                    r && (
                      <span
                        className="dl-rv-outline"
                        key={change.layer}
                        style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
                      />
                    )
                  );
                })}
              </div>
              {!board.added &&
                !board.removed &&
                mode === 'slider' &&
                amount > 0 &&
                amount < 100 && (
                  <>
                    <div
                      className="dl-rv-divider"
                      style={{ left: `${100 - amount}%` }}
                      role="slider"
                      tabIndex={0}
                      aria-label="Wipe divider"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={amount}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                          event.preventDefault();
                          event.stopPropagation();
                          setAmount(
                            Math.max(
                              0,
                              Math.min(100, amount + (event.key === 'ArrowLeft' ? 1 : -1)),
                            ),
                          );
                        }
                      }}
                      onPointerDown={(event) =>
                        event.currentTarget.setPointerCapture(event.pointerId)
                      }
                      onPointerMove={(event) => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId))
                          setAmount(Math.round(100 * (1 - position(event).x / width)));
                      }}
                    >
                      <i>↔</i>
                    </div>
                    <span className="dl-rv-side" style={{ left: 10 }}>
                      {board.resolution ? 'Main' : 'Old'}
                    </span>
                    <span className="dl-rv-side" style={{ right: 10 }}>
                      {board.resolution ? 'This proposal' : 'New'}
                    </span>
                  </>
                )}
              {editable && tool !== 'select' && (
                <div
                  className="dl-rv-gesture"
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId);
                    const p = position(event);
                    setGesture({ start: p, points: [p] });
                  }}
                  onPointerMove={(event) => {
                    if (gesture)
                      setGesture({
                        ...gesture,
                        points: [...gesture.points.slice(0, 4094), position(event)],
                      });
                  }}
                  onPointerCancel={() => setGesture(null)}
                  onPointerUp={(event) => {
                    if (!gesture) return;
                    const points = [...gesture.points, position(event)];
                    if (tool === 'area') {
                      const a = areaFor([gesture.start, position(event)]);
                      if (a.w > 1 && a.h > 1) beginNote(gesture.start, { area: a });
                    } else
                      beginNote(
                        gesture.start,
                        tool === 'draw' ? { drawing: drawingFor(points) } : {},
                      );
                    setGesture(null);
                    if (tool === 'pin') setTool('select');
                  }}
                />
              )}
              {area && (
                <span
                  className="dl-rv-mark"
                  style={{ left: area.x, top: area.y, width: area.w, height: area.h }}
                />
              )}
              {marks.map(
                (mark) =>
                  mark.area && (
                    <span
                      key={`area-${mark.id}`}
                      className="dl-rv-mark"
                      style={{
                        left: mark.area.x + reviewNotePosition(mark, activeBoxes).x - mark.x,
                        top: mark.area.y + reviewNotePosition(mark, activeBoxes).y - mark.y,
                        width: mark.area.w,
                        height: mark.area.h,
                      }}
                    >
                      {draft &&
                        (mark.id === 'draft' || mark.id === draft.id) &&
                        ['tl', 'tr', 'bl', 'br'].map((corner) => (
                          <span
                            key={corner}
                            className={`dl-rv-handle ${corner}`}
                            role="button"
                            tabIndex={0}
                            aria-label={`Resize area ${corner}`}
                            onPointerDown={(event) => {
                              event.preventDefault();
                              event.currentTarget.setPointerCapture(event.pointerId);
                            }}
                            onPointerMove={(event) => {
                              if (event.currentTarget.hasPointerCapture(event.pointerId))
                                resizeArea(corner, position(event));
                            }}
                            onKeyDown={(event) => {
                              if (
                                !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(
                                  event.key,
                                )
                              )
                                return;
                              event.preventDefault();
                              event.stopPropagation();
                              const a = draft.area!,
                                p = reviewNotePosition(draft, activeBoxes);
                              resizeArea(corner, {
                                x:
                                  a.x +
                                  (corner.includes('r') ? a.w : 0) +
                                  p.x -
                                  draft.x +
                                  (event.key === 'ArrowRight'
                                    ? 1
                                    : event.key === 'ArrowLeft'
                                      ? -1
                                      : 0),
                                y:
                                  a.y +
                                  (corner.includes('b') ? a.h : 0) +
                                  p.y -
                                  draft.y +
                                  (event.key === 'ArrowDown'
                                    ? 1
                                    : event.key === 'ArrowUp'
                                      ? -1
                                      : 0),
                              });
                            }}
                          />
                        ))}
                    </span>
                  ),
              )}
              <svg className="dl-rv-stroke" viewBox={`0 0 ${width} ${board.h}`}>
                {marks
                  .filter((p) => p.drawing)
                  .flatMap((p) =>
                    p.drawing!.strokes.map((stroke, i) => (
                      <path
                        key={`${p.id}-${i}`}
                        d={reviewDrawingPath(p.drawing!, stroke)}
                        transform={`translate(${reviewNotePosition(p, activeBoxes).x - p.x} ${reviewNotePosition(p, activeBoxes).y - p.y})`}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={3}
                      />
                    )),
                  )}
                {gesture && tool === 'draw' && (
                  <path
                    d={reviewDrawingPath(
                      drawingFor(gesture.points),
                      drawingFor(gesture.points).strokes[0],
                    )}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={3}
                  />
                )}
              </svg>
              {pins.map((pin) => {
                const p = reviewNotePosition(pin, activeBoxes);
                return (
                  <button
                    key={pin.id}
                    className="dl-rv-note"
                    style={{ left: Math.min(p.x, width - 40), top: p.y }}
                    onClick={() => editable && setDraft({ ...pin })}
                    aria-label={`Note ${pin.number}: ${pin.text}`}
                  >
                    <span className="dl-rv-num">{pin.number}</span>
                    <span className="dl-rv-bubble">
                      {pin.text}
                      {pin.resolved && ' · Addressed'}
                    </span>
                  </button>
                );
              })}
              {draft && draftPoint && (
                <form
                  className="dl-rv-compose"
                  style={{
                    left: Math.max(
                      12,
                      Math.min(
                        draftBounds
                          ? draftBounds.x + draftBounds.w - 320 + draftPoint.x - draft.x
                          : draftPoint.x + 12,
                        width - 332,
                      ),
                    ),
                    top: Math.max(
                      12,
                      Math.min(
                        draftBounds
                          ? draftBounds.y + draftBounds.h + 12 + draftPoint.y - draft.y
                          : draftPoint.y + 28,
                        board.h - 156,
                      ),
                    ),
                  }}
                  onSubmit={(event) => {
                    event.preventDefault();
                    save();
                  }}
                >
                  <textarea
                    autoFocus
                    aria-label="Note"
                    placeholder="What should change here?"
                    value={draft.text}
                    onChange={(event) => setDraft({ ...draft, text: event.target.value })}
                  />
                  <div>
                    <Action onClick={() => setDraft(null)}>Cancel</Action>
                    <Action type="submit" variant="primary" disabled={busy || !draft.text.trim()}>
                      Save note
                    </Action>
                  </div>
                </form>
              )}
            </div>
          </div>
          <span
            className={`dl-rv-grip${dragging ? ' on' : ''}`}
            role="slider"
            tabIndex={0}
            aria-label="Screen width"
            aria-valuemin={320}
            aria-valuemax={Math.min(2560, available)}
            aria-valuenow={Math.round(width)}
            onKeyDown={(event) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                event.stopPropagation();
                setChosen(
                  event.key === 'Home'
                    ? 320
                    : event.key === 'End'
                      ? available
                      : Math.max(
                          320,
                          Math.min(available, width + (event.key === 'ArrowRight' ? 10 : -10)),
                        ),
                );
              }
            }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragging(true);
            }}
            onPointerMove={(event) => {
              if (dragging) {
                const rect = stage.current!.getBoundingClientRect();
                setChosen(
                  Math.round(
                    Math.max(
                      320,
                      Math.min(2560, available, 2 * (event.clientX - rect.left - rect.width / 2)),
                    ),
                  ),
                );
              }
            }}
            onPointerUp={() => setDragging(false)}
            onPointerCancel={() => setDragging(false)}
          />
          {dragging && <span className="dl-rv-size">{Math.round(width)} px</span>}
        </div>
      </div>
      {!readyFrames && (
        <div className="dl-rv-stage-loading">
          <Skeleton block label="Loading the design" />
        </div>
      )}
      <div className="dl-rv-dock">
        {tools.map((entry) => (
          <button
            type="button"
            className={`dl-rv-tool${entry.tool === tool ? ' on' : ''}`}
            aria-label={entry.label}
            title={entry.label}
            aria-pressed={entry.tool === tool}
            disabled={!editable && entry.tool !== 'select'}
            key={entry.tool}
            onClick={() => setTool(entry.tool)}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d={entry.path} />
            </svg>
          </button>
        ))}
        <span className="dl-rv-sep" />
        {board.added || board.removed ? (
          <span className="dl-rv-readout dl-rv-single">
            {board.added ? 'New screen · nothing to compare' : 'Removed screen · old only'}
          </span>
        ) : (
          <>
            <label className="dl-rv-scrub">
              <span>{board.resolution ? 'Main' : 'Old'}</span>
              <input
                aria-label={board.resolution ? 'Main to this proposal' : 'Old to new'}
                type="range"
                min={0}
                max={100}
                value={amount}
                onChange={(event) => setAmount(Number(event.target.value))}
              />
              <span>{board.resolution ? 'This proposal' : 'New'}</span>
            </label>
            <div className="dl-seg" role="group" aria-label="How to compare">
              {(['onion', 'slider'] as const).map((value) => (
                <button
                  key={value}
                  className={mode === value ? 'on' : ''}
                  aria-pressed={mode === value}
                  onClick={() => saveCompareMode(value)}
                >
                  {value === 'onion' ? 'Overlay' : 'Wipe'}
                </button>
              ))}
            </div>
          </>
        )}
        {!board.added && <span className="dl-rv-sep" />}
        {!board.added && (
          <button className="dl-rv-readout" onClick={() => setChosen(null)} title="Fit to stage">
            {chosen === null && board.w > 500 ? 'Fit · ' : ''}
            {Math.round(width)} px
          </button>
        )}
      </div>
    </div>
  );
}
