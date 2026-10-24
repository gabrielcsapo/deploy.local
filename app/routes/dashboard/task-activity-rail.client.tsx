'use client';
import { IconButton, ActionCluster } from '@/components/ui';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { WorkspaceIcon } from './workspace-icon';

import {
  listenForSplitEscape,
  restoreSplitFocus,
  splitPreference,
  selectedSplitTab,
  selectSplitTab,
  toggledSplitTab,
  type SplitTab,
} from './task-split-state';
export function useActivityRail(task = '') {
  const [preferences, setPreferences] = useState(() => {
    try {
      return splitPreference(
        JSON.parse(localStorage.getItem('deploy:right-split') ?? 'null'),
        JSON.parse(localStorage.getItem('deploy:activity-rail') ?? '{}'),
      );
    } catch {
      return splitPreference(null);
    }
  });
  const [expanded, setExpanded] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const tab = selectedSplitTab(preferences, task);
  const mode = tab ? 'open' : 'closed';
  const width = preferences.width;
  useEffect(() => {
    setExpanded(false);
  }, [task]);
  const select = useCallback(
    (next: SplitTab | null, size = width) => {
      if (next && !document.activeElement?.closest('.pw-activity-rail')) {
        const trigger =
          document.activeElement instanceof HTMLElement &&
          document.activeElement.matches('[data-split-toggle]')
            ? document.activeElement
            : [...document.querySelectorAll<HTMLElement>(`[data-split-toggle="${next}"]`)].find(
                (element) => element.getClientRects().length,
              );
        if (trigger) opener.current = trigger;
      }
      setPreferences((current) => {
        const value = selectSplitTab(current, task, next, size);
        try {
          localStorage.setItem('deploy:right-split', JSON.stringify(value));
        } catch {}
        return value;
      });
      if (next !== 'changes') setExpanded(false);
      if (!next) requestAnimationFrame(() => restoreSplitFocus(opener.current));
    },
    [task, width],
  );
  function update(next: string, size = width) {
    select(next === 'open' ? (tab ?? 'activity') : null, size);
  }
  return {
    mode,
    width,
    tab,
    select,
    update,
    expanded,
    setExpanded,
    toggle: (next: SplitTab) => select(toggledSplitTab(tab, next)),
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
  const heading = useRef<HTMLElement>(null);
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
    previousMode.current = rail.mode;
  }, [rail.mode]);
  useEffect(() => {
    if (rail.mode !== 'open') return;
    return listenForSplitEscape(document, () => rail.select(null));
  }, [rail]);
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
    heading.current?.focus({ preventScroll: true });
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
        className={`pw-activity-rail pw-right-split ${rail.expanded ? 'is-expanded' : ''}`}
        ref={root}
        data-open={rail.mode === 'open'}
        inert={rail.mode !== 'open'}
        aria-hidden={rail.mode !== 'open'}
        role={overlay && rail.mode === 'open' ? 'dialog' : undefined}
        aria-modal={overlay && rail.mode === 'open' ? true : undefined}
        aria-label={overlay ? 'Task panel' : undefined}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            rail.update('closed');
          }
          if (event.key === 'Tab' && overlay) {
            const items = [
              ...root.current!.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href], [tabindex="0"]',
              ),
            ].filter((element) => {
              if (!element.getClientRects().length || element.tabIndex < 0) return false;
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
        {!overlay && !rail.expanded && (
          <div
            className="ds-sidebar-resizer pw-activity-resizer"
            role="separator"
            tabIndex={0}
            aria-label="Resize task panel"
            aria-orientation="vertical"
            aria-valuemin={320}
            aria-valuemax={720}
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
                      ? 720
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
        <aside aria-label="Task panel">
          <div className="pw-activity-grab" />
          <header className="pw-activity-header">
            <nav
              ref={heading}
              tabIndex={-1}
              role="tablist"
              aria-label="Task panel"
              className="ui-scroll-strip min-w-0"
            >
              {(['computer', 'changes', 'activity', 'terminal'] as const).map(
                (tab, index, tabs) => (
                  <button
                    key={tab}
                    id={`split-tab-${tab}`}
                    role="tab"
                    aria-selected={rail.tab === tab}
                    aria-controls={`split-panel-${tab}`}
                    tabIndex={rail.tab === tab ? 0 : -1}
                    onClick={() => rail.select(tab)}
                    onKeyDown={(event) => {
                      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                      event.preventDefault();
                      const next =
                        tabs[
                          event.key === 'Home'
                            ? 0
                            : event.key === 'End'
                              ? tabs.length - 1
                              : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) %
                                tabs.length
                        ];
                      rail.select(next);
                      document.getElementById(`split-tab-${next}`)?.focus();
                    }}
                  >
                    {tab[0].toUpperCase() + tab.slice(1)}
                  </button>
                ),
              )}
            </nav>
            <ActionCluster>
              {rail.tab === 'changes' && !overlay && (
                <IconButton
                  size="compact"
                  icon={rail.expanded ? 'collapse' : 'expand'}
                  label={rail.expanded ? 'Collapse Changes' : 'Expand Changes'}
                  onClick={() => rail.setExpanded(!rail.expanded)}
                />
              )}
              <IconButton
                size="compact"
                icon="close"
                label="Close task panel"
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
