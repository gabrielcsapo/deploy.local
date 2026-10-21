'use client';
import { IconButton, ActionCluster } from '@/components/ui';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { WorkspaceIcon } from './workspace-icon';
import { activityMode } from './interaction-layout';
export function useActivityRail() {
  const [mode, setMode] = useState('closed');
  const [width, setWidth] = useState(400);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('deploy:activity-rail') ?? '{}');
      setMode(activityMode(saved.mode));
      if (saved.mode === 'collapsed')
        localStorage.setItem('deploy:activity-rail', JSON.stringify({ ...saved, mode: 'closed' }));
      if (Number.isFinite(saved.width)) setWidth(Math.max(320, Math.min(560, saved.width)));
    } catch {}
  }, []);
  function update(next: string, size = width) {
    const bounded = Math.max(320, Math.min(560, size));
    setMode(activityMode(next));
    setWidth(bounded);
    try {
      localStorage.setItem(
        'deploy:activity-rail',
        JSON.stringify({ mode: activityMode(next), width: bounded }),
      );
    } catch {}
  }
  return {
    mode,
    width,
    update,
    style: { '--activity-width': `${width}px` } as CSSProperties,
  };
}
export function ActivityRail({
  rail,
  children,
}: {
  rail: ReturnType<typeof useActivityRail>;
  jobs: Record<string, any>[];
  children?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const keyboard = useRef(false);
  const previousMode = useRef(rail.mode);
  useEffect(() => {
    const key = () => {
      keyboard.current = true;
    };
    const pointer = () => {
      keyboard.current = false;
    };
    document.addEventListener('keydown', key, true);
    document.addEventListener('pointerdown', pointer, true);
    return () => {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('pointerdown', pointer, true);
    };
  }, []);
  useEffect(() => {
    if (rail.mode === 'open' && previousMode.current !== 'open' && keyboard.current)
      heading.current?.focus({ preventScroll: true });
    if (rail.mode === 'closed' && previousMode.current === 'open') {
      [...document.querySelectorAll<HTMLElement>('[data-activity-toggle]')]
        .find((el) => el.getClientRects().length)
        ?.focus({ preventScroll: true });
    }
    previousMode.current = rail.mode;
  }, [rail.mode]);
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
    const element = root.current!;
    const siblings = [...element.parentElement!.children].filter(
      (e) => e !== element && !e.classList.contains('pw-activity-scrim'),
    ) as HTMLElement[];
    const states = siblings.map((e) => e.inert);
    siblings.forEach((e) => {
      e.inert = true;
    });
    return () => {
      siblings.forEach((e, i) => {
        e.inert = states[i]!;
      });
    };
  }, [rail.mode, overlay]);
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
        data-open={rail.mode === 'open'}
        inert={rail.mode !== 'open'}
        aria-hidden={rail.mode !== 'open'}
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
            if (
              event.shiftKey &&
              (document.activeElement === first || document.activeElement === heading.current)
            ) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
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
            <h2 ref={heading} tabIndex={-1}>
              Activity
            </h2>
            <ActionCluster>
              <IconButton
                size="compact"
                icon="close"
                label="Close Activity"
                shortcut="Esc"
                onClick={() => rail.update('closed')}
              />
            </ActionCluster>
          </header>
          {children}
        </aside>
      </div>
    </>
  );
}
