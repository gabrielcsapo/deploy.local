'use client';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Button } from '@/components/ui';
import { WorkspaceIcon } from './workspace-icon';
import { activitySummary } from './task-activity-summary';
export function useActivityRail() {
  const [mode, setMode] = useState('closed');
  const [width, setWidth] = useState(400);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('deploy:activity-rail') ?? '{}');
      if (['closed', 'open', 'collapsed'].includes(saved.mode)) setMode(saved.mode);
      if (Number.isFinite(saved.width)) setWidth(Math.max(320, Math.min(560, saved.width)));
    } catch {}
  }, []);
  function update(next: string, size = width) {
    const bounded = Math.max(320, Math.min(560, size));
    setMode(next);
    setWidth(bounded);
    try {
      localStorage.setItem('deploy:activity-rail', JSON.stringify({ mode: next, width: bounded }));
    } catch {}
  }
  return {
    mode,
    width,
    update,
    style: { '--activity-width': `${mode === 'collapsed' ? 44 : width}px` } as CSSProperties,
  };
}
export function ActivityRail({
  rail,
  jobs,
  children,
}: {
  rail: ReturnType<typeof useActivityRail>;
  jobs: Record<string, any>[];
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [overlay, setOverlay] = useState(false);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const query = matchMedia('(width < 1100px)');
    const update = () => setOverlay(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (rail.mode !== 'open' || !overlay) return;
    const previous = document.activeElement as HTMLElement | null;
    const element = root.current!;
    const siblings = [...element.parentElement!.children].filter(
      (e) => e !== element && !e.classList.contains('pw-activity-scrim'),
    ) as HTMLElement[];
    const states = siblings.map((e) => e.inert);
    siblings.forEach((e) => {
      e.inert = true;
    });
    element.querySelector<HTMLElement>('button')?.focus();
    return () => {
      siblings.forEach((e, i) => {
        e.inert = states[i]!;
      });
      if (previous?.isConnected) previous.focus();
    };
  }, [rail.mode, overlay]);
  const summary = activitySummary(jobs);
  if (rail.mode === 'closed') return null;
  return (
    <>
      {overlay && rail.mode === 'open' && (
        <div
          className="pw-activity-scrim"
          aria-hidden="true"
          onClick={() => rail.update('closed')}
        />
      )}
      <div
        className="pw-activity-rail"
        ref={root}
        data-collapsed={rail.mode === 'collapsed'}
        role={overlay && rail.mode === 'open' ? 'dialog' : undefined}
        aria-modal={overlay && rail.mode === 'open' ? true : undefined}
        aria-label={overlay ? 'Activity' : undefined}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            rail.update('closed');
          }
          if (event.key === 'Tab' && overlay) {
            const items = [
              ...root.current!.querySelectorAll<HTMLElement>(
                'button:not(:disabled), summary, a[href], [tabindex="0"]',
              ),
            ].filter((element) => {
              if (!element.getClientRects().length) return false;
              for (
                let ancestor = element.parentElement;
                ancestor && ancestor !== root.current;
                ancestor = ancestor.parentElement
              ) {
                if (
                  ancestor instanceof HTMLDetailsElement &&
                  !ancestor.open &&
                  !ancestor.querySelector(':scope > summary')?.contains(element)
                )
                  return false;
              }
              return true;
            });
            const first = items[0];
            const last = items.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        {rail.mode === 'collapsed' ? (
          <Button
            variant="link"
            className="pw-activity-strip"
            aria-label={`Expand ${summary.label}`}
            onClick={() => rail.update('open')}
          >
            <span>◐{summary.running}</span>
            <span className={summary.failing ? 'pw-activity-failed' : ''}>✕{summary.failing}</span>
            <span>✓{summary.passed}</span>
          </Button>
        ) : (
          <>
            {!overlay && (
              <div
                className="ds-sidebar-resizer pw-activity-resizer"
                role="separator"
                tabIndex={0}
                aria-label="Resize Activity"
                aria-orientation="vertical"
                aria-valuemin={320}
                aria-valuemax={560}
                aria-valuenow={rail.width}
                data-dragging={dragging || undefined}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.currentTarget.focus();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  drag.current = { x: event.clientX, width: rail.width };
                  setDragging(true);
                }}
                onPointerMove={(event) => {
                  if (drag.current)
                    rail.update('open', drag.current.width + drag.current.x - event.clientX);
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
                onDoubleClick={() => rail.update('open', 400)}
                onKeyDown={(event) => {
                  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                    event.preventDefault();
                    rail.update(
                      'open',
                      event.key === 'Home'
                        ? 320
                        : event.key === 'End'
                          ? 560
                          : rail.width +
                            (event.key === 'ArrowLeft' ? 1 : -1) * (event.shiftKey ? 32 : 16),
                    );
                  }
                }}
              >
                <span className="ds-resize-affordance" aria-hidden="true">
                  <WorkspaceIcon name="resize-horizontal" />
                </span>
              </div>
            )}
            <aside aria-label="Activity">
              <div className="pw-activity-grab" />
              <header className="pw-activity-header">
                <strong>Activity</strong>
                <Button variant="link" onClick={() => rail.update('collapsed')}>
                  Collapse
                </Button>
                <Button variant="link" onClick={() => rail.update('closed')}>
                  Close
                </Button>
              </header>
              {children}
            </aside>
          </>
        )}
      </div>
    </>
  );
}
