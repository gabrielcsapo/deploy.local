'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'react-flight-router/client';
import { useDashboardData } from './data.client';
import {
  OverviewIcon,
  DeploymentsIcon,
  HistoryIcon,
  LogsIcon,
  DiscoverIcon,
  SettingsIcon,
  BuildIcon,
  TerminalIcon,
  RequestsIcon,
  ResourcesIcon,
  ExternalLinkIcon,
} from '../../components/dashboard/icons';
import { appUrl } from './detail/shared';

interface Command {
  id: string;
  title: string;
  /** Short label rendered to the right of the title. Status, app type, etc. */
  hint?: string;
  /** Group header for visual organization. */
  group: 'Go to' | 'Apps' | 'App pages' | 'Quick';
  icon?: React.ReactNode;
  perform: () => void;
}

/**
 * Cmd-K command palette mounted globally inside the dashboard.
 *
 * Opens on `cmd+k` / `ctrl+k`. Provides fuzzy search over fleet
 * navigation, per-app pages, and quick actions (open in new tab).
 * Keyboard-first: arrow keys move the selection, Enter executes,
 * Escape closes. Falls back to mouse for everything.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { deployments } = useDashboardData();
  const { navigate } = useRouter();

  // Global keyboard listener — cmd+k toggles, escape closes.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isTyping =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery('');
        setSelectedIdx(0);
        return;
      }
      // "/" as a power-user shortcut when not already typing in a field.
      if (e.key === '/' && !isTyping && !open) {
        e.preventDefault();
        setOpen(true);
        setQuery('');
        setSelectedIdx(0);
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  // Focus the input whenever the palette opens.
  useEffect(() => {
    if (open) {
      // Defer to next frame so the input is mounted before we focus it.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Reset selection whenever the filter narrows.
  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  const close = useCallback(() => setOpen(false), []);

  // Compose the full command list. Memoized on the deployments array so
  // it rebuilds whenever an app is added/removed but not on every keystroke.
  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [];

    cmds.push({
      id: 'nav-overview',
      title: 'Overview',
      group: 'Go to',
      icon: <OverviewIcon />,
      perform: () => navigate('/dashboard'),
    });
    cmds.push({
      id: 'nav-apps',
      title: 'Apps',
      group: 'Go to',
      icon: <DeploymentsIcon />,
      perform: () => navigate('/dashboard/apps'),
    });
    cmds.push({
      id: 'nav-activity',
      title: 'Activity',
      group: 'Go to',
      icon: <HistoryIcon />,
      perform: () => navigate('/dashboard/activity'),
    });
    cmds.push({
      id: 'nav-logs',
      title: 'Logs',
      group: 'Go to',
      icon: <LogsIcon />,
      perform: () => navigate('/dashboard/logs'),
    });
    cmds.push({
      id: 'nav-discover',
      title: 'Shared apps',
      group: 'Go to',
      icon: <DiscoverIcon />,
      perform: () => navigate('/dashboard/discover'),
    });
    cmds.push({
      id: 'nav-settings',
      title: 'Settings',
      group: 'Go to',
      icon: <SettingsIcon />,
      perform: () => navigate('/dashboard/settings'),
    });

    const tabSpecs: { path: string; label: string; icon: React.ReactNode }[] = [
      { path: '', label: 'Overview', icon: <OverviewIcon /> },
      { path: 'logs', label: 'Logs', icon: <LogsIcon /> },
      { path: 'terminal', label: 'Terminal', icon: <TerminalIcon /> },
      { path: 'requests', label: 'Requests', icon: <RequestsIcon /> },
      { path: 'resources', label: 'Resources', icon: <ResourcesIcon /> },
      { path: 'build', label: 'Build', icon: <BuildIcon /> },
      { path: 'history', label: 'Activity', icon: <HistoryIcon /> },
      { path: 'settings', label: 'Settings', icon: <SettingsIcon /> },
    ];

    for (const d of deployments) {
      cmds.push({
        id: `app-${d.name}`,
        title: d.name,
        group: 'Apps',
        hint: d.status,
        icon: <DeploymentsIcon />,
        perform: () => navigate(`/dashboard/${d.name}`),
      });
      cmds.push({
        id: `quick-open-${d.name}`,
        title: `Open ${d.name} in new tab`,
        group: 'Quick',
        icon: <ExternalLinkIcon />,
        perform: () => window.open(appUrl(d.name), '_blank', 'noopener,noreferrer'),
      });
      for (const tab of tabSpecs) {
        if (!tab.path) continue; // overview is already covered by the bare app entry
        cmds.push({
          id: `app-${d.name}-${tab.path}`,
          title: `${d.name} → ${tab.label}`,
          group: 'App pages',
          icon: tab.icon,
          perform: () => navigate(`/dashboard/${d.name}/${tab.path}`),
        });
      }
    }

    return cmds;
  }, [deployments, navigate]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    // Fuzzy-ish: keep commands where every space-separated token matches
    // somewhere in `title` or `group`. Simple and good enough for keyboard.
    const tokens = q.split(/\s+/);
    return commands.filter((c) => {
      const hay = `${c.title} ${c.group} ${c.hint ?? ''}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }, [commands, query]);

  // Re-group filtered results in order: Go to · Apps · App pages · Quick.
  const grouped = useMemo(() => {
    const order: Command['group'][] = ['Go to', 'Apps', 'App pages', 'Quick'];
    const groups = new Map<Command['group'], Command[]>();
    for (const c of filtered) {
      if (!groups.has(c.group)) groups.set(c.group, []);
      groups.get(c.group)!.push(c);
    }
    return order
      .filter((g) => groups.has(g))
      .map((g) => ({ group: g, items: groups.get(g)! }));
  }, [filtered]);

  // Flat list of commands in render order — used to map keyboard
  // ↑/↓ navigation back to the original Command object.
  const flatOrdered = useMemo(() => grouped.flatMap((s) => s.items), [grouped]);
  const total = flatOrdered.length;
  const clamped = total === 0 ? 0 : Math.min(selectedIdx, total - 1);

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => (total === 0 ? 0 : (i + 1) % total));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => (total === 0 ? 0 : (i - 1 + total) % total));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = flatOrdered[clamped];
        if (cmd) {
          close();
          cmd.perform();
        }
      }
    },
    [close, clamped, flatOrdered, total],
  );

  // Keep the active row scrolled into view when the selection moves past
  // the visible area (especially with long Apps lists).
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cmd-idx="${clamped}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [clamped, open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[55] flex items-start justify-center px-4 pt-[12vh] sm:pt-[18vh]">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={close} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative w-full max-w-xl rounded-xl border border-white/10 bg-bg-surface/95 backdrop-blur-md shadow-[0_24px_60px_-20px_hsl(258_60%_4%/0.7),0_0_0_1px_hsl(266_90%_66%/0.18)] overflow-hidden"
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06]">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-4 text-text-tertiary shrink-0">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Type to search · apps, pages, actions"
            className="flex-1 bg-transparent border-0 outline-none text-sm text-text placeholder:text-text-tertiary"
            spellCheck={false}
            autoComplete="off"
          />
          <kbd className="hidden sm:inline-flex items-center gap-0.5 text-[10px] font-mono text-text-tertiary border border-white/10 rounded px-1.5 py-0.5">
            esc
          </kbd>
        </div>

        <div
          ref={listRef}
          className="max-h-[55vh] overflow-y-auto scrollbar-thin py-2"
        >
          {total === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-text-tertiary">
              No matches for &ldquo;<span className="text-text">{query}</span>&rdquo;
            </p>
          ) : (
            grouped.map((section) => {
              let runningIdx = grouped
                .slice(0, grouped.indexOf(section))
                .reduce((acc, s) => acc + s.items.length, 0);
              return (
                <div key={section.group} className="mb-1">
                  <p className="eyebrow px-4 pt-2 pb-1">{section.group}</p>
                  {section.items.map((cmd) => {
                    const idx = runningIdx++;
                    const isActive = idx === clamped;
                    return (
                      <button
                        key={cmd.id}
                        type="button"
                        data-cmd-idx={idx}
                        onMouseEnter={() => setSelectedIdx(idx)}
                        onClick={() => {
                          close();
                          cmd.perform();
                        }}
                        className={`w-full text-left flex items-center gap-3 px-4 py-2 text-sm transition-colors ${
                          isActive
                            ? 'bg-bg-hover text-text shadow-[inset_2px_0_0_0_hsl(266_90%_66%/0.7)]'
                            : 'text-text-secondary hover:bg-bg-hover/60'
                        }`}
                      >
                        {cmd.icon && (
                          <span className="text-text-tertiary shrink-0">{cmd.icon}</span>
                        )}
                        <span className="flex-1 truncate">{cmd.title}</span>
                        {cmd.hint && (
                          <span className="text-[10px] font-mono uppercase tracking-wider text-text-tertiary shrink-0">
                            {cmd.hint}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-4 py-2 border-t border-white/[0.06] text-[10px] font-mono uppercase tracking-wider text-text-tertiary">
          <span className="flex items-center gap-3">
            <span>
              <kbd className="border border-white/10 rounded px-1 py-0.5 mr-1">↑↓</kbd>
              navigate
            </span>
            <span>
              <kbd className="border border-white/10 rounded px-1 py-0.5 mr-1">↵</kbd>
              select
            </span>
          </span>
          <span className="tabular-nums">
            {total} {total === 1 ? 'result' : 'results'}
          </span>
        </div>
      </div>
    </div>
  );
}
