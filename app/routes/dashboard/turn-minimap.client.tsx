'use client';
import { useEffect, useRef, useState, type RefObject } from 'react';
import './turn-minimap.css';
import { showTurnMinimap, jumpToTurn, minimapKey, type TranscriptTurn } from './turn-minimap';
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
  const [preview, setPreview] = useState<number | null>(null);
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
  return (
    <nav
      className="turn-minimap"
      aria-label="Conversation turns"
      onMouseLeave={() => setPreview(null)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPreview(null);
      }}
      onKeyDown={(event) => {
        const next = minimapKey(event.key, active, turns.length);
        if (next === undefined) return;
        event.preventDefault();
        setFocused(next);
        buttons.current[next]?.focus();
      }}
    >
      <div className="turn-minimap-ticks">
        {turns.map((turn, index) => (
          <button
            key={turn.id}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            tabIndex={index === active ? 0 : -1}
            onFocus={() => {
              setFocused(index);
              setPreview(index);
            }}
            onMouseEnter={() => setPreview(index)}
            aria-label={`Turn ${index + 1}: ${turn.excerpt}`}
            title={turn.excerpt}
            data-visible={visible.has(`message-${turn.id}`) || undefined}
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
      {preview !== null && turns[preview] && (
        <span role="tooltip" className="turn-minimap-tooltip">
          {turns[preview].excerpt}
        </span>
      )}
    </nav>
  );
}
