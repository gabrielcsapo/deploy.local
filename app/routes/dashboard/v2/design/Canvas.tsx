'use client';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { boardName, type Canvas as CanvasData, type Section } from './model';

export type View = { x: number; y: number; z: number };
export type Selection = { board: string; layer: string | null } | null;
export type Tool = 'move' | 'hand' | 'comment';
export type Frames = RefObject<Map<string, HTMLIFrameElement>>;

/** The element a layer ID names inside a mounted board, or null. */
export function layerElement(frames: Frames, board: string, layer: string) {
  const doc = frames.current?.get(board)?.contentDocument;
  return doc?.querySelector<HTMLElement>(`[data-layer="${CSS.escape(layer)}"]`) ?? null;
}

export function rectOf(frames: Frames, canvas: CanvasData, board: string, layer: string | null) {
  const placed = canvas.boards[board];
  if (!placed) return null;
  if (!layer) return { x: placed.x, y: placed.y, w: placed.w, h: placed.h };
  const element = layerElement(frames, board, layer);
  if (!element) return null;
  const box = element.getBoundingClientRect();
  return { x: placed.x + box.left, y: placed.y + box.top, w: box.width, h: box.height };
}

export function DesignCanvas({
  canvas,
  section,
  base,
  view,
  setView,
  tool,
  selection,
  select,
  frames,
  revision,
  onFrameLoad,
  agentBoards,
}: {
  canvas: CanvasData;
  section: Section | null;
  base: string;
  view: View;
  setView: (update: (view: View) => View) => void;
  tool: Tool;
  selection: Selection;
  select: (selection: Selection) => void;
  frames: Frames;
  revision: number;
  onFrameLoad: () => void;
  /** Boards an open agent branch changed, outlined while its overlay shows. */
  agentBoards?: Set<string>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1200, h: 800 });
  const [hover, setHover] = useState<Selection>(null);
  const [space, setSpace] = useState(false);
  const drag = useRef<{ x: number; y: number; view: View } | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ w: entry.contentRect.width, h: entry.contentRect.height }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Figma's gestures: scroll pans, pinch or ⌘/Ctrl-scroll zooms around the pointer.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        const cx = event.clientX - box.left;
        const cy = event.clientY - box.top;
        setView((current) => {
          const z = Math.min(4, Math.max(0.02, current.z * Math.exp(-event.deltaY * 0.01)));
          return {
            z,
            x: cx - ((cx - current.x) * z) / current.z,
            y: cy - ((cy - current.y) * z) / current.z,
          };
        });
      } else
        setView((current) => ({
          ...current,
          x: current.x - event.deltaX,
          y: current.y - event.deltaY,
        }));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [setView]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (
        event.code === 'Space' &&
        !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
      )
        setSpace(true);
    };
    const up = (event: KeyboardEvent) => event.code === 'Space' && setSpace(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const panning = tool === 'hand' || space;
  const files = section?.boards ?? Object.keys(canvas.boards);
  // Boards load only while they are on screen and large enough to read.
  const visible = (file: string) => {
    const board = canvas.boards[file];
    const left = board.x * view.z + view.x;
    const top = board.y * view.z + view.y;
    return (
      view.z >= 0.08 &&
      left < size.w + 200 &&
      top < size.h + 200 &&
      left + board.w * view.z > -200 &&
      top + board.h * view.z > -200
    );
  };

  const pick = useCallback(
    (file: string, event: React.MouseEvent): Selection => {
      const frame = frames.current?.get(file);
      const doc = frame?.contentDocument;
      if (!frame || !doc) return { board: file, layer: null };
      const box = frame.getBoundingClientRect();
      const element = doc.elementFromPoint(
        (event.clientX - box.left) / view.z,
        (event.clientY - box.top) / view.z,
      );
      const layer = element?.closest('[data-layer]')?.getAttribute('data-layer') ?? null;
      return { board: file, layer };
    },
    [frames, view.z],
  );

  const box = (target: Selection) =>
    target ? rectOf(frames, canvas, target.board, target.layer) : null;
  void revision;
  const selected = box(selection);
  const hovered =
    hover && (hover.board !== selection?.board || hover.layer !== selection?.layer)
      ? box(hover)
      : null;
  const notes = Object.entries(canvas.notes ?? {}).filter(
    ([id, note]) => !id.startsWith('section-') && note.text && files.length,
  );

  return (
    <div
      ref={host}
      className={`dz-canvas${panning ? ' panning' : ''}${drag.current ? ' dragging' : ''}`}
      onPointerDown={(event) => {
        if (!panning && event.button !== 1) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, y: event.clientY, view };
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const start = drag.current;
        setView(() => ({
          ...start.view,
          x: start.view.x + event.clientX - start.x,
          y: start.view.y + event.clientY - start.y,
        }));
      }}
      onPointerUp={() => (drag.current = null)}
      onClick={(event) => {
        if (event.target === event.currentTarget) select(null);
      }}
    >
      <div
        className="dz-world"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}
      >
        {Object.entries(canvas.notes ?? {})
          .filter(([id]) => id.startsWith('section-'))
          .map(([id, note]) => (
            <div
              key={id}
              className="dz-section-title"
              style={{
                left: note.x,
                top: note.y,
                transform: `translateY(-100%) scale(${1 / Math.max(view.z, 0.05)})`,
              }}
            >
              {note.text?.replace(/\s*\(for approval\)\s*$/i, '')}
            </div>
          ))}
        {notes.map(([id, note]) => (
          <div
            key={id}
            className={`dz-note ${note.fill ?? 'yellow'}`}
            style={{ left: note.x, top: note.y, width: note.w ?? 280 }}
          >
            {note.text}
          </div>
        ))}
        {Object.entries(canvas.boards).map(([file, board]) => {
          const on = selection?.board === file;
          const agent = agentBoards?.has(file);
          return (
            <div
              key={file}
              className={`dz-board${on ? ' on' : ''}${agent ? ' agent' : ''}`}
              style={{ left: board.x, top: board.y, width: board.w, height: board.h }}
            >
              <button
                type="button"
                className="dz-board-name"
                // Names stay at screen size and, like Figma's, never run past their board.
                style={{ transform: `scale(${1 / view.z})`, maxWidth: board.w * view.z }}
                onClick={() => select({ board: file, layer: null })}
              >
                <span className="dz-t">{boardName(file)}</span>
                <span className="dz-tag">
                  {board.w <= 500 ? `Phone ${board.w}` : `Web ${board.w}`}
                </span>
                {agent && <span className="dz-tag agent">Agent’s version</span>}
              </button>
              {visible(file) ? (
                <iframe
                  title={board.title ?? boardName(file)}
                  sandbox="allow-same-origin"
                  src={`${base}/boards/${encodeURIComponent(file)}`}
                  width={board.w}
                  height={board.h}
                  loading="lazy"
                  ref={(frame) => {
                    if (frame) frames.current?.set(file, frame);
                    else frames.current?.delete(file);
                  }}
                  onLoad={onFrameLoad}
                />
              ) : (
                <div className="dz-board-placeholder">{board.title ?? boardName(file)}</div>
              )}
              {!panning && (
                <div
                  className="dz-board-hit"
                  onMouseMove={(event) => setHover(pick(file, event))}
                  onMouseLeave={() => setHover(null)}
                  onClick={(event) => {
                    event.stopPropagation();
                    select(pick(file, event));
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    const placed = canvas.boards[file];
                    const z = Math.min(1, (size.h - 96) / placed.h, (size.w - 96) / placed.w);
                    setView(() => ({
                      z,
                      x: (size.w - placed.w * z) / 2 - placed.x * z,
                      y: (size.h - placed.h * z) / 2 - placed.y * z,
                    }));
                  }}
                />
              )}
            </div>
          );
        })}
        {hovered && (
          <div
            className="dz-hover"
            style={{
              left: hovered.x,
              top: hovered.y,
              width: hovered.w,
              height: hovered.h,
              borderWidth: 1 / view.z,
            }}
          />
        )}
        {selected && (
          <div
            className="dz-selection"
            style={{
              left: selected.x,
              top: selected.y,
              width: selected.w,
              height: selected.h,
              borderWidth: 1.5 / view.z,
            }}
          >
            {[0, 1, 2, 3].map((corner) => (
              <i
                key={corner}
                className={`c${corner}`}
                style={{ width: 7 / view.z, height: 7 / view.z, borderWidth: 1.5 / view.z }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
