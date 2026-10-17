'use client';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import tokens from '../../design-tokens.json';

const preference = 'deploy:context-sidebar-width';
const minimum = tokens.size.sidebarMin;
const defaultWidth = tokens.size.sidebar;
const maximum = () =>
  Math.max(
    minimum,
    Math.min(
      tokens.size.sidebarMax,
      window.innerWidth - tokens.size.rail - tokens.size.workPaneMin,
    ),
  );
const clamp = (width: number) => Math.max(minimum, Math.min(maximum(), width));

export function useSidebarResize() {
  const [width, setWidth] = useState(defaultWidth);
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(preference));
      if (saved >= minimum)
        setWidth(window.innerWidth <= 760 ? Math.min(tokens.size.sidebarMax, saved) : clamp(saved));
    } catch {
      // Resizing still works when browser preferences cannot be saved.
    }
    const resize = () => {
      if (window.innerWidth > 760) setWidth((current) => clamp(current));
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  function update(next: number) {
    const value = clamp(next);
    setWidth(value);
    try {
      localStorage.setItem(preference, String(value));
    } catch {
      // Keep the current session usable without persistent storage.
    }
  }
  return { width, update, style: { '--ds-sidebar-width': `${width}px` } as CSSProperties };
}

export function SidebarResizeHandle({
  width,
  update,
}: {
  width: number;
  update: (width: number) => void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className="ds-sidebar-resizer"
      role="separator"
      tabIndex={0}
      aria-label="Resize context sidebar"
      aria-orientation="vertical"
      aria-valuemin={minimum}
      aria-valuemax={typeof window === 'undefined' ? tokens.size.sidebarMax : maximum()}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      title="Drag to resize. Arrow keys adjust width; double-click to reset."
      data-dragging={dragging || undefined}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (drag.current) update(drag.current.width + event.clientX - drag.current.x);
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        drag.current = null;
        setDragging(false);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        setDragging(false);
      }}
      onDoubleClick={() => update(defaultWidth)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && drag.current) {
          update(drag.current.width);
          drag.current = null;
          setDragging(false);
        } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          update(
            event.key === 'Home'
              ? minimum
              : event.key === 'End'
                ? maximum()
                : width + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 32 : 16),
          );
        }
      }}
    />
  );
}
