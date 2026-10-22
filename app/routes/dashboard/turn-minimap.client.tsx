'use client';
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import './turn-minimap.css';
import {
  showTurnMinimap,
  jumpToTurn,
  minimapKey,
  tickMagnification,
  type TranscriptTurn,
} from './turn-minimap';
/** One index per snapshot; observers only watch the rendered user-message anchors. */
export function TurnMinimap({
  turns,
  transcript,
}: {
  turns: TranscriptTurn[];
  transcript: RefObject<HTMLDivElement | null>;
}) {
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const [overflow, setOverflow] = useState(false);
  const [focused, setFocused] = useState(0);
  // The lens follows the pointer as a fractional row, or the focused tick from the keyboard.
  const [pointer, setPointer] = useState<number | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const ticks = useRef<HTMLDivElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    const root = transcript.current;
    if (!root) return;
    const intersection = new IntersectionObserver(
      (entries) => {
        setVisible((previous) => {
          const next = new Set(previous);
          for (const entry of entries) {
            if (entry.isIntersecting) next.add(entry.target.id);
            else next.delete(entry.target.id);
          }
          return next;
        });
      },
      { root, threshold: 0 },
    );
    for (const turn of turns) {
      const node = document.getElementById(`message-${turn.id}`);
      if (node) intersection.observe(node);
    }
    const resize = new ResizeObserver(() => setOverflow(root.scrollHeight > root.clientHeight + 1));
    resize.observe(root);
    if (root.firstElementChild) resize.observe(root.firstElementChild);
    return () => {
      intersection.disconnect();
      resize.disconnect();
    };
  }, [turns, transcript]);
  if (!showTurnMinimap(turns, overflow)) return null;
  const active = Math.min(focused, turns.length - 1);
  const lens = keyboard ? active : pointer;
  const current = lens === null ? null : Math.min(turns.length - 1, Math.max(0, Math.round(lens)));
  const pitch = buttons.current[0]?.offsetHeight || 1;
  const first = buttons.current[0]?.offsetTop ?? 0;
  const previewTop =
    current === null ? 0 : first + (current + 0.5) * pitch - (ticks.current?.scrollTop ?? 0);
  return (
    <nav
      className="turn-minimap"
      aria-label="Conversation turns"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setKeyboard(false);
      }}
      onKeyDown={(event) => {
        const next = minimapKey(event.key, active, turns.length);
        if (next === undefined) return;
        event.preventDefault();
        setFocused(next);
        setKeyboard(true);
        buttons.current[next]?.focus();
      }}
    >
      <div
        ref={ticks}
        className="turn-minimap-ticks"
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setKeyboard(false);
          setPointer(
            (event.clientY - box.top + event.currentTarget.scrollTop - first) / pitch - 0.5,
          );
        }}
        onPointerLeave={() => setPointer(null)}
      >
        {turns.map((turn, index) => (
          <button
            key={turn.id}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            tabIndex={index === active ? 0 : -1}
            onFocus={() => setFocused(index)}
            aria-label={`Turn ${index + 1}: ${turn.excerpt}`}
            data-visible={visible.has(`message-${turn.id}`) || undefined}
            data-current={index === current || undefined}
            style={{ '--magnify': tickMagnification(index, lens) } as CSSProperties}
            onClick={() =>
              jumpToTurn(
                document.getElementById(`message-${turn.id}`),
                matchMedia('(prefers-reduced-motion: reduce)').matches,
              )
            }
          >
            <span className="turn-minimap-tick" />
          </button>
        ))}
      </div>
      {current !== null && turns[current] && (
        <div role="tooltip" className="turn-minimap-preview" style={{ top: previewTop }}>
          <strong>{turns[current].prompt || turns[current].excerpt}</strong>
          {turns[current].reply && <p>{turns[current].reply}</p>}
        </div>
      )}
    </nav>
  );
}
