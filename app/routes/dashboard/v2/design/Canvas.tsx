'use client';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  boardName,
  changeLabel,
  type Canvas as CanvasData,
  type LayerChange,
  type Section,
} from './model';
import { ComponentFrame, dropTarget, type DropTarget, type Placing } from './Assets';

export type View = { x: number; y: number; z: number };
export type Selection = { board: string; layer: string | null } | null;
export type Tool =
  | 'move'
  | 'hand'
  | 'comment'
  | 'rectangle'
  | 'ellipse'
  | 'line'
  | 'frame'
  | 'text'
  | 'pen'
  | 'sticky';
/** What the drawing tools make, in board pixels; the server writes the markup. */
export type DrawnShape =
  | { kind: 'rectangle' | 'ellipse' | 'frame'; x: number; y: number; w: number; h: number }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'text'; x: number; y: number; text: string }
  | { kind: 'vector'; points: [number, number][]; closed?: boolean };
/** A finished drawing: a layer in a board, a new board, or a sticky note on the canvas. */
export type Drawn =
  | { board: string; shape: DrawnShape }
  | { canvas: 'board'; x: number; y: number; kind: 'web' | 'phone' }
  | { canvas: 'note'; x: number; y: number; text: string };
type Point = { x: number; y: number };
const drawingTools = new Set<Tool>([
  'rectangle',
  'ellipse',
  'line',
  'frame',
  'text',
  'pen',
  'sticky',
]);
export type Frames = RefObject<Map<string, HTMLIFrameElement>>;
/** An agent working on this design, as deploy_design presence reports it. */
export type AgentPresence = {
  taskId: string;
  title: string;
  board: string;
  layer: string | null;
  note: string;
};

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
  agentLayers,
  agents = [],
  inReview,
  boardSrc,
  onEditText,
  onDraw,
  onNote,
  retypeNext,
  onRetyped,
  placing,
  onTarget,
  owner,
  designFiles,
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
  agents?: AgentPresence[];
  /** Per board, the layers the open agent branch changed, each outlined with what changed. */
  agentLayers?: Map<string, LayerChange[]>;
  /** Boards a waiting design review would change. */
  inReview?: Set<string>;
  /** Boards you edited: where each one's latest version is, and a count that reloads it. */
  boardSrc?: Map<string, { base: string; reload: number }>;
  /** Present when the design can be edited: double-clicking a text layer retypes it in place. */
  onEditText?: (board: string, layer: string, text: string) => void;
  /** Present when the design can be edited: the drawing tools hand over what they drew. */
  onDraw?: (drawn: Drawn) => void;
  /** Retyping a sticky note; empty text removes it. */
  onNote?: (id: string, text: string) => void;
  /** A text layer just drawn, to retype in place once its board shows it. */
  retypeNext?: { board: string; layer: string } | null;
  onRetyped?: () => void;
  /** A component dragged from Assets; the canvas works out where it would land. */
  placing?: Placing | null;
  onTarget?: (target: DropTarget | null) => void;
  /** Your name, shown by the pointer while you place a component. */
  owner?: string;
  /** The design files at the commit on screen, for drawing the component being placed. */
  designFiles?: string | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1200, h: 800 });
  const [hover, setHover] = useState<Selection>(null);
  const [space, setSpace] = useState(false);
  const drag = useRef<{ x: number; y: number; view: View } | null>(null);
  // Touch: one finger pans, two pinch. A pan is not a tap, so it selects nothing.
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; mid: { x: number; y: number }; view: View } | null>(null);
  const panned = useRef(false);
  // The text layer being retyped in place; its board lets the pointer through while it is.
  const [typing, setTyping] = useState<{ board: string; layer: string } | null>(null);
  // A shape being drawn, in canvas coordinates; the pen collects points until it is done.
  const [draft, setDraft] = useState<{
    tool: Tool;
    board: string | null;
    start: Point;
    end: Point;
    points?: Point[];
  } | null>(null);
  const [noteDraft, setNoteDraft] = useState<Point | null>(null);
  const [editingNote, setEditingNote] = useState<string | null>(null);

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

  const retype = (file: string, layer: string) => {
    const element = layerElement(frames, file, layer);
    // Only a layer that is just text: retyping a stack would flatten what is inside it.
    if (!element || !onEditText || element.children.length || !element.textContent?.trim())
      return false;
    const before = element.textContent;
    element.contentEditable = 'plaintext-only';
    element.focus();
    element.ownerDocument.getSelection()?.selectAllChildren(element);
    setTyping({ board: file, layer });
    let cancelled = false;
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        element.blur();
      }
      if (event.key === 'Escape') {
        cancelled = true;
        element.textContent = before;
        element.blur();
      }
    };
    const done = () => {
      element.removeEventListener('keydown', keys);
      element.removeAttribute('contenteditable');
      setTyping(null);
      const text = element.textContent ?? '';
      if (!cancelled && text !== before) onEditText(file, layer, text);
    };
    element.addEventListener('keydown', keys);
    element.addEventListener('blur', done, { once: true });
    return true;
  };

  useEffect(() => {
    if (!retypeNext || !onRetyped) return;
    if (retype(retypeNext.board, retypeNext.layer)) onRetyped();
    // Waits for the board to load again: frame loads bump the revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retypeNext, revision]);

  // Drawing: a point on screen in canvas coordinates, and the board under it.
  const toWorld = (event: { clientX: number; clientY: number }): Point => {
    const rect = host.current!.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - view.x) / view.z,
      y: (event.clientY - rect.top - view.y) / view.z,
    };
  };
  const boardAt = (point: Point) =>
    Object.entries(canvas.boards).find(
      ([, b]) => point.x >= b.x && point.x <= b.x + b.w && point.y >= b.y && point.y <= b.y + b.h,
    )?.[0] ?? null;
  const drawing = Boolean(onDraw) && drawingTools.has(tool) && !panning;
  const finishPen = (closed: boolean) => {
    if (!draft?.points || !draft.board || !onDraw) return setDraft(null);
    const placed = canvas.boards[draft.board];
    const points = draft.points.map((p) => [p.x - placed.x, p.y - placed.y] as [number, number]);
    if (points.length >= 2)
      onDraw({ board: draft.board, shape: { kind: 'vector', points, closed } });
    setDraft(null);
  };
  useEffect(() => {
    if (!draft || draft.tool !== 'pen') return;
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Enter') finishPen(false);
      if (event.key === 'Escape') setDraft(null);
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  });
  const finishDrag = () => {
    if (!draft || !onDraw) return setDraft(null);
    const { start, end } = draft;
    let [x, y] = [Math.min(start.x, end.x), Math.min(start.y, end.y)];
    let [w, h] = [Math.abs(end.x - start.x), Math.abs(end.y - start.y)];
    const clicked = w * view.z < 3 && h * view.z < 3;
    setDraft(null);
    if (draft.tool === 'frame' && !draft.board)
      return onDraw({
        canvas: 'board',
        x: Math.round(start.x),
        y: Math.round(start.y),
        kind: !clicked && w < 900 ? 'phone' : 'web',
      });
    if (!draft.board) return;
    const placed = canvas.boards[draft.board];
    if (draft.tool === 'line') {
      if (clicked) return;
      return onDraw({
        board: draft.board,
        shape: {
          kind: 'line',
          x1: start.x - placed.x,
          y1: start.y - placed.y,
          x2: end.x - placed.x,
          y2: end.y - placed.y,
        },
      });
    }
    // A click without a drag draws the shape at a starting size.
    if (clicked) [x, y, w, h] = [start.x, start.y, 100, 100];
    onDraw({
      board: draft.board,
      shape: {
        kind: draft.tool as 'rectangle' | 'ellipse' | 'frame',
        x: Math.round(x - placed.x),
        y: Math.round(y - placed.y),
        w: Math.round(w),
        h: Math.round(h),
      },
    });
  };
  // Placing a component: the stack under the pointer and where in it, or a spot on the board.
  const [drop, setDrop] = useState<DropTarget | null>(null);
  useEffect(() => {
    let next: DropTarget | null = null;
    if (placing && host.current) {
      const rect = host.current.getBoundingClientRect();
      const inside =
        placing.x >= rect.left &&
        placing.x <= rect.right &&
        placing.y >= rect.top &&
        placing.y <= rect.bottom;
      const point = toWorld({ clientX: placing.x, clientY: placing.y });
      const board = inside ? boardAt(point) : null;
      const doc = board ? frames.current?.get(board)?.contentDocument : null;
      if (board && doc) {
        const placed = canvas.boards[board];
        next = dropTarget(board, placed, doc, { x: point.x - placed.x, y: point.y - placed.y });
      }
    }
    setDrop(next);
    onTarget?.(next);
    // toWorld and boardAt read the current view and canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placing, view, canvas]);
  const near = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) * view.z < 8;

  const box = (target: Selection) =>
    target ? rectOf(frames, canvas, target.board, target.layer) : null;
  void revision;
  const selected = box(selection);
  // A drawn layer shows its size under the selection, as it did while it was drawn.
  const drawnLayer =
    selection?.layer &&
    layerElement(frames, selection.board, selection.layer)?.hasAttribute('data-name') &&
    /position:\s*absolute/.test(
      layerElement(frames, selection.board, selection.layer)?.getAttribute('style') ?? '',
    );
  // While a component is placed, the drop line is the only mark on the board.
  const hovered =
    !placing && hover && (hover.board !== selection?.board || hover.layer !== selection?.layer)
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
        if (event.pointerType === 'touch') {
          if ((event.target as HTMLElement).closest('.dz-draw')) return;
          touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          const rect = event.currentTarget.getBoundingClientRect();
          const points = [...touches.current.values()];
          if (points.length === 2) {
            const [a, b] = points;
            pinch.current = {
              d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
              mid: { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top },
              view,
            };
            drag.current = null;
          } else if (points.length === 1) {
            drag.current = { x: event.clientX, y: event.clientY, view };
            panned.current = false;
          }
          return;
        }
        if (!panning && event.button !== 1) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, y: event.clientY, view };
      }}
      onPointerMove={(event) => {
        if (event.pointerType === 'touch' && touches.current.has(event.pointerId)) {
          touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          const start = pinch.current;
          if (start && touches.current.size === 2) {
            const [a, b] = [...touches.current.values()];
            const z = Math.min(
              4,
              Math.max(0.02, (start.view.z * Math.hypot(a.x - b.x, a.y - b.y)) / start.d),
            );
            const rect = event.currentTarget.getBoundingClientRect();
            const mid = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
            panned.current = true;
            setView(() => ({
              z,
              x: mid.x - ((start.mid.x - start.view.x) * z) / start.view.z,
              y: mid.y - ((start.mid.y - start.view.y) * z) / start.view.z,
            }));
            return;
          }
          const from = drag.current;
          if (!from) return;
          if (!panned.current && Math.hypot(event.clientX - from.x, event.clientY - from.y) < 6)
            return;
          panned.current = true;
          setView(() => ({
            ...from.view,
            x: from.view.x + event.clientX - from.x,
            y: from.view.y + event.clientY - from.y,
          }));
          return;
        }
        if (!drag.current) return;
        const start = drag.current;
        setView(() => ({
          ...start.view,
          x: start.view.x + event.clientX - start.x,
          y: start.view.y + event.clientY - start.y,
        }));
      }}
      onPointerUp={(event) => {
        touches.current.delete(event.pointerId);
        if (touches.current.size < 2) pinch.current = null;
        if (!touches.current.size) drag.current = null;
        else if (event.pointerType !== 'touch') drag.current = null;
      }}
      onPointerCancel={(event) => {
        touches.current.delete(event.pointerId);
        pinch.current = null;
        drag.current = null;
      }}
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
            className={`dz-note ${note.fill ?? 'yellow'}${onNote ? ' editable' : ''}`}
            style={{ left: note.x, top: note.y, width: note.w ?? 280 }}
            contentEditable={editingNote === id ? 'plaintext-only' : undefined}
            suppressContentEditableWarning
            ref={(element) => {
              if (element && editingNote === id && document.activeElement !== element) {
                element.focus();
                document.getSelection()?.selectAllChildren(element);
              }
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              if (onNote) setEditingNote(id);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.currentTarget.textContent = note.text ?? '';
                event.currentTarget.blur();
              }
            }}
            onBlur={(event) => {
              const text = event.currentTarget.textContent?.trim() ?? '';
              setEditingNote(null);
              if (text !== note.text) onNote?.(id, text);
            }}
          >
            {note.text}
          </div>
        ))}
        {noteDraft && (
          <div
            className="dz-note yellow editable"
            style={{ left: noteDraft.x, top: noteDraft.y, width: 240, minHeight: 160 }}
            contentEditable="plaintext-only"
            aria-label="New sticky note"
            ref={(element) => {
              if (element && document.activeElement !== element) element.focus();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.currentTarget.textContent = '';
                event.currentTarget.blur();
              }
            }}
            onBlur={(event) => {
              const text = event.currentTarget.textContent?.trim() ?? '';
              const at = noteDraft;
              setNoteDraft(null);
              if (text && onDraw)
                onDraw({ canvas: 'note', x: Math.round(at.x), y: Math.round(at.y), text });
            }}
          />
        )}

        {Object.entries(canvas.boards).map(([file, board]) => {
          const on = selection?.board === file;
          const agent = agentBoards?.has(file);
          return (
            <div
              key={file}
              className={`dz-board${on ? ' on' : ''}${agent ? ' agent' : ''}${agentLayers?.get(file)?.length ? ' has-layers' : ''}${typing?.board === file ? ' typing' : ''}`}
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
                {board.w * view.z > 160 && (
                  <span className="dz-tag">
                    {board.w <= 500 ? `Phone ${board.w}` : `Web ${board.w}`}
                  </span>
                )}
                {agent && <span className="dz-tag agent">Agent’s version</span>}
                {!agent && inReview?.has(file) && <span className="dz-tag review">In review</span>}
              </button>
              {visible(file) ? (
                <BoardFrame
                  key={`${base}:${boardSrc?.get(file)?.reload ?? 0}`}
                  file={file}
                  title={board.title ?? boardName(file)}
                  src={`${boardSrc?.get(file)?.base ?? base}/boards/${encodeURIComponent(file)}`}
                  width={board.w}
                  height={board.h}
                  frames={frames}
                  onLoad={onFrameLoad}
                />
              ) : (
                <div className="dz-board-placeholder">{board.title ?? boardName(file)}</div>
              )}
              {!panning && typing?.board !== file && (
                <div
                  className="dz-board-hit"
                  onMouseMove={(event) => setHover(pick(file, event))}
                  onMouseLeave={() => setHover(null)}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (panned.current) return void (panned.current = false);
                    select(pick(file, event));
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    const target = pick(file, event);
                    if (target?.layer && retype(file, target.layer)) return;
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
        {[...(agentLayers ?? [])].flatMap(([file, layers]) =>
          layers.map((layer) => {
            const at = rectOf(frames, canvas, file, layer.layer);
            if (!at) return null;
            return (
              <div
                key={`${file}:${layer.layer}`}
                className="dz-agent-change"
                style={{
                  left: at.x,
                  top: at.y,
                  width: at.w,
                  height: at.h,
                  outlineWidth: 1.5 / view.z,
                  outlineOffset: 3 / view.z,
                }}
              >
                <b style={{ transform: `scale(${1 / view.z})` }}>{changeLabel(layer)}</b>
              </div>
            );
          }),
        )}
        {agents.map((agent) => {
          const at = canvas.boards[agent.board]
            ? rectOf(frames, canvas, agent.board, agent.layer)
            : null;
          if (!at) return null;
          return (
            <div
              key={agent.taskId}
              className="dz-agent-box"
              style={{
                left: at.x,
                top: at.y,
                width: at.w,
                height: at.h,
                borderWidth: 1.5 / view.z,
              }}
            >
              <b style={{ transform: `scale(${1 / view.z})` }}>
                {agent.note || `Working on ${agent.layer ?? boardName(agent.board)}`}
              </b>
              <span className="dz-agent-cursor" style={{ transform: `scale(${1 / view.z})` }}>
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 2l16 9-7 2-3 7z" />
                </svg>
                <i>{agent.title}</i>
              </span>
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
        {selected && drawnLayer && (
          <span
            className="dz-dims"
            style={{
              left: selected.x + selected.w / 2,
              top: selected.y + selected.h,
              transform: `translate(-50%, ${8 / view.z}px) scale(${1 / view.z})`,
            }}
          >
            {Math.round(selected.w)} × {Math.round(selected.h)}
          </span>
        )}
        {draft && <DraftShape draft={draft} z={view.z} />}
        {drop && drop.line.w > 0 && (
          <>
            <div
              className={`dz-drop-line${drop.line.vertical ? ' vertical' : ''}`}
              style={
                drop.line.vertical
                  ? {
                      ['--dz-dot' as string]: `${8 / view.z}px`,
                      left: drop.line.x,
                      top: drop.line.y,
                      height: drop.line.w,
                      width: 2 / view.z,
                    }
                  : {
                      ['--dz-dot' as string]: `${8 / view.z}px`,
                      left: drop.line.x,
                      top: drop.line.y,
                      width: drop.line.w,
                      height: 2 / view.z,
                    }
              }
            />
            <span
              className="dz-drop-tip"
              style={{
                left: drop.line.vertical ? drop.line.x : drop.line.x + drop.line.w,
                top: drop.line.vertical ? drop.line.y + drop.line.w : drop.line.y,
                transform: `translate(${8 / view.z}px, -50%) scale(${1 / view.z})`,
              }}
            >
              Into {drop.into.split(' › ').pop()} · {drop.place}
            </span>
          </>
        )}
      </div>
      {placing && host.current && (
        <div
          className="dz-ghost"
          style={{
            left: placing.x - host.current.getBoundingClientRect().left + 12,
            top: placing.y - host.current.getBoundingClientRect().top + 12,
          }}
        >
          {designFiles && (
            <div className="dz-ghost-card">
              <ComponentFrame
                component={placing.component}
                props={placing.props}
                files={designFiles}
                width={drop?.line.vertical ? 240 : Math.min(drop?.line.w || 320, 480)}
                height={40}
                hug
                scale={view.z}
              />
            </div>
          )}
          {owner && <span className="dz-you">{owner}</span>}
        </div>
      )}
      {drawing && (
        <div
          className={`dz-draw ${tool}`}
          aria-label="Drawing area"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            // Keeps focus where the tool puts it (a new sticky note) and stops text selection.
            event.preventDefault();
            const point = toWorld(event);
            const board = boardAt(point);
            if (tool === 'sticky') {
              // A click while a new note is open finishes that note.
              if (noteDraft) return (document.activeElement as HTMLElement | null)?.blur();
              return setNoteDraft(point);
            }
            if (tool === 'text') {
              if (!board) return;
              const placed = canvas.boards[board];
              return onDraw!({
                board,
                shape: {
                  kind: 'text',
                  x: Math.round(point.x - placed.x),
                  y: Math.round(point.y - placed.y),
                  text: 'Text',
                },
              });
            }
            if (tool === 'pen') {
              if (!draft) {
                if (board) setDraft({ tool, board, start: point, end: point, points: [point] });
              } else if (draft.points!.length > 2 && near(point, draft.points![0])) finishPen(true);
              else setDraft({ ...draft, points: [...draft.points!, point], end: point });
              return;
            }
            event.currentTarget.setPointerCapture(event.pointerId);
            setDraft({ tool, board, start: point, end: point });
          }}
          onPointerMove={(event) => draft && setDraft({ ...draft, end: toWorld(event) })}
          onPointerUp={() => draft && draft.tool !== 'pen' && finishDrag()}
          onDoubleClick={() => draft?.tool === 'pen' && finishPen(false)}
        />
      )}
    </div>
  );
}

/** What is being drawn, before it is saved: its outline and, for boxes, its size. */
function DraftShape({
  draft,
  z,
}: {
  draft: { tool: Tool; board: string | null; start: Point; end: Point; points?: Point[] };
  z: number;
}) {
  const { tool, start, end } = draft;
  if (tool === 'line' || tool === 'pen') {
    const points = tool === 'line' ? [start, end] : [...draft.points!, end];
    return (
      <svg className="dz-draft-path" width="1" height="1" aria-hidden="true">
        <polyline
          points={points.map((p) => `${p.x},${p.y}`).join(' ')}
          strokeWidth={1.5 / z}
          fill="none"
        />
      </svg>
    );
  }
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const w = Math.abs(end.x - start.x);
  const h = Math.abs(end.y - start.y);
  if (w * z < 3 && h * z < 3) return null;
  // A frame on open canvas becomes a board: Phone 390 when drawn narrow, otherwise Web 1440.
  const label =
    tool === 'frame' && !draft.board
      ? w < 900
        ? 'Phone 390'
        : 'Web 1440'
      : `${Math.round(w)} × ${Math.round(h)}`;
  return (
    <>
      <div
        className={`dz-draft${tool === 'ellipse' ? ' round' : ''}`}
        style={{ left: x, top: y, width: w, height: h, borderWidth: 1.5 / z }}
      />
      <span
        className="dz-dims"
        style={{
          left: x + w / 2,
          top: y + h,
          transform: `translate(-50%, ${8 / z}px) scale(${1 / z})`,
        }}
      >
        {label}
      </span>
    </>
  );
}

/**
 * One board's page. It keeps the address it opened with, so your own edits, already applied to
 * what is on screen, do not reload it; a new key (another branch, a reset) loads it again.
 */
function BoardFrame({
  file,
  title,
  src,
  width,
  height,
  frames,
  onLoad,
}: {
  file: string;
  title: string;
  src: string;
  width: number;
  height: number;
  frames: Frames;
  onLoad: () => void;
}) {
  const [opened] = useState(src);
  return (
    <iframe
      title={title}
      sandbox="allow-same-origin"
      src={opened}
      width={width}
      height={height}
      loading="lazy"
      ref={(frame) => {
        if (frame) frames.current?.set(file, frame);
        else frames.current?.delete(file);
      }}
      onLoad={onLoad}
    />
  );
}
