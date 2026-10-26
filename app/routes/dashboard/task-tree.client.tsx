'use client';
import { ActionCluster, IconButton, Skeleton } from '@/components/ui';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Button, TextField, WorkspaceIcon } from '@/components/ui';
import {
  idleProject,
  readPinned,
  recentTasks,
  sidebarStorageKey,
  taskRunning,
  projectDisclosureShown,
  projectTaskPreview,
  selectedTaskInProject,
  taskAge,
  taskStatus,
  taskTree,
  type TreeProject,
  type TreeTask,
} from './task-tree';
import './task-tree.css';
import { getAuth } from './detail/shared';
import {
  toggleTaskPin,
  sidebarRecentsCollapsed,
  writeSidebarPreference,
} from './task-sidebar-state';

type Task = TreeTask & { status: string };
const expansionKey = 'workspace-task-tree-expanded-v2';
/** Tasks shown per project before Show more, like recent chats in Codex and Claude. */
const visibleLimit = 5;

export function TaskTree({
  projects,
  tasks,
  selected,
  loaded,
  error,
  waitingForAnswer,
  openTask,
  prefetchTask,
  newTask,
  addRepository,
  retry,
  shortcuts = true,
  storagePrefix = `workspace:${encodeURIComponent(getAuth()?.username || '')}`,
  setTaskClosed,
}: {
  projects: TreeProject[];
  tasks: Task[];
  selected: string;
  loaded: boolean;
  error: string;
  waitingForAnswer: ReadonlySet<string>;
  openTask: (id: string) => void;
  prefetchTask?: (id: string) => void;
  newTask: (projectId?: string) => void;
  addRepository: () => void;
  retry: () => void;
  shortcuts?: boolean;
  storagePrefix?: string;
  setTaskClosed?: (id: string, closed: boolean) => Promise<void>;
}) {
  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelPrefetch = () => clearTimeout(prefetchTimer.current);
  const schedulePrefetch = (id: string) => {
    cancelPrefetch();
    prefetchTimer.current = setTimeout(() => prefetchTask?.(id), 120);
  };
  useEffect(() => () => clearTimeout(prefetchTimer.current), []);
  const [pinned, setPinned] = useState<string[]>([]);
  const [recentsCollapsed, setRecentsCollapsed] = useState(false);
  const [pending, setPending] = useState<string>();
  const [undo, setUndo] = useState<string>();
  const [actionError, setActionError] = useState('');
  useEffect(() => {
    setPinned(readPinned(localStorage, storagePrefix));
    setRecentsCollapsed(
      sidebarRecentsCollapsed(localStorage, sidebarStorageKey(storagePrefix, 'recents-collapsed')),
    );
  }, [storagePrefix]);
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(undefined), 5000);
    return () => clearTimeout(timer);
  }, [undo]);
  function pin(id: string) {
    const next = toggleTaskPin(pinned, id);
    setPinned(next);
    writeSidebarPreference(localStorage, sidebarStorageKey(storagePrefix, 'pinned'), next);
  }
  function collapseRecents() {
    setRecentsCollapsed(!recentsCollapsed);
    writeSidebarPreference(
      localStorage,
      sidebarStorageKey(storagePrefix, 'recents-collapsed'),
      !recentsCollapsed,
    );
  }
  async function close(id: string, closed: boolean) {
    if (!setTaskClosed) return;
    setPending(id);
    setActionError('');
    try {
      await setTaskClosed(id, closed);
      setUndo(closed ? id : undefined);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(undefined);
    }
  }
  const id = useId();
  const searchField = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [allRecents, setAllRecents] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!shortcuts) return;
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (!root.current?.getClientRects().length) return;
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setSearchOpen(true);
        searchField.current?.querySelector('input')?.focus();
      } else if (event.key.toLowerCase() === 'n') {
        event.preventDefault();
        event.stopImmediatePropagation();
        newTask();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [newTask, shortcuts]);
  useEffect(() => {
    if (searchOpen) searchField.current?.querySelector('input')?.focus();
  }, [searchOpen]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [restored, setRestored] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(expansionKey) || '{}');
      if (saved && typeof saved === 'object' && !Array.isArray(saved))
        setExpanded(
          Object.fromEntries(
            Object.entries(saved).filter(([, value]) => typeof value === 'boolean'),
          ),
        );
    } catch {
      // Storage may be disabled or contain an older, invalid value.
    }
    setRestored(true);
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!restored) return;
    try {
      localStorage.setItem(expansionKey, JSON.stringify(expanded));
    } catch {
      // The tree still works when storage is unavailable.
    }
  }, [expanded, restored]);
  const needsYou = useCallback(
    (task: Task) =>
      waitingForAnswer.has(task.id) ||
      Boolean(task.controlRequest) ||
      (task.status !== 'merged' && task.pull?.status === 'open') ||
      ['waiting', 'review', 'ready'].includes(task.status),
    [waitingForAnswer],
  );
  // The sidebar glyph is for work blocked on you; ready-to-review tasks stay quiet, as in Codex.
  const blocked = useCallback(
    (task: Task) =>
      waitingForAnswer.has(task.id) || Boolean(task.controlRequest) || task.status === 'waiting',
    [waitingForAnswer],
  );
  const running = (task: Task) => taskRunning(task.status);
  const glyph = (rows: Task[]) =>
    rows.some(blocked) ? (
      <WorkspaceIcon name="alert" />
    ) : rows.some(running) ? (
      <span className="task-tree-spinner" />
    ) : null;
  const groups = useMemo(
    () =>
      taskTree(projects, attentionOnly ? tasks.filter(needsYou) : tasks, search).filter(
        (group) => !attentionOnly || group.tasks.length,
      ),
    [projects, tasks, search, attentionOnly, needsYou],
  );
  const searching = Boolean(search.trim()) || attentionOnly;
  const ordered = groups
    .flatMap((group) => group.tasks)
    .sort(
      (a, b) =>
        String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')) ||
        a.id.localeCompare(b.id),
    );
  const recents = recentTasks(ordered, pinned);
  const pinnedTasks = ordered.filter((task) => pinned.includes(task.id));
  function clearSearch() {
    setSearch('');
    setAttentionOnly(false);
    searchField.current?.querySelector('input')?.focus();
  }
  function selectTask(event: MouseEvent<HTMLAnchorElement>, taskId: string) {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openTask(taskId);
  }
  const selectedInProject = selectedTaskInProject(groups, selected, expanded, showAll, searching);
  function renderTask(task: Task, recent = false, isPinned = false) {
    const projectFilled = selected === task.id && (recent ? !selectedInProject : selectedInProject);
    const filled = isPinned ? selected === task.id : !pinned.includes(task.id) && projectFilled;
    const age = taskAge(task.updatedAt, now);
    const status = taskStatus(
      task.status,
      waitingForAnswer.has(task.id),
      task.pull,
      Boolean(task.controlRequest),
    );
    return (
      <li key={task.id} className="task-tree-row">
        {/* A plain anchor: the router's Link always navigates on click (even when the handler
            prevents it), which pushed a second history entry next to selectTask's own. The href
            keeps ⌘-click and "open in new tab" working. */}
        <a
          href={`/dashboard?task=${encodeURIComponent(task.id)}`}
          className="task-tree-task"
          data-finished={(!running(task) && !blocked(task)) || undefined}
          aria-current={filled ? 'page' : undefined}
          data-selected-ink={selected === task.id || undefined}
          aria-label={`${task.title}, ${status.label}, ${age.label}`}
          title={`${task.title} — ${status.label}. ${age.label}`}
          onMouseEnter={() => schedulePrefetch(task.id)}
          onMouseLeave={cancelPrefetch}
          onFocus={() => schedulePrefetch(task.id)}
          onBlur={cancelPrefetch}
          onPointerDown={() => prefetchTask?.(task.id)}
          onClick={(event) => selectTask(event, task.id)}
        >
          <span className="task-tree-title">{task.title}</span>
          <span className="task-tree-signal" aria-hidden="true">
            {glyph([task])}
          </span>
        </a>
        <ActionCluster className="task-tree-row-actions">
          <IconButton
            size="compact"
            icon="pin"
            label={pinned.includes(task.id) ? 'Unpin' : 'Pin'}
            pressed={pinned.includes(task.id)}
            onClick={() => pin(task.id)}
          />
          {setTaskClosed && !['done', 'merged'].includes(task.status) && (
            <span title={running(task) ? 'Stop active work before marking done' : 'Mark done'}>
              <IconButton
                size="compact"
                icon="check"
                label="Mark done"
                disabled={running(task) || pending === task.id}
                onClick={() => void close(task.id, true)}
              />
            </span>
          )}
        </ActionCluster>
      </li>
    );
  }
  return (
    <div className="task-tree-navigation" ref={root}>
      <header className="ds-context-heading">
        <strong>deploy.local</strong>
        <ActionCluster>
          <IconButton
            icon="user"
            label="Account and settings"
            className="phone-only"
            onClick={(event) =>
              window.dispatchEvent(
                new CustomEvent('deploy:account', { detail: event.currentTarget }),
              )
            }
          />
          <IconButton
            icon="bell"
            label="Notifications: tasks needing you"
            pressed={attentionOnly}
            onClick={() => setAttentionOnly(!attentionOnly)}
          />
          <IconButton
            icon="search"
            label="Search tasks"
            shortcut="⌘K"
            pressed={searchOpen}
            onClick={() => {
              setSearchOpen(!searchOpen);
              setSearch('');
            }}
          />
        </ActionCluster>
      </header>
      <button
        className="task-tree-task task-tree-compose"
        onClick={() => newTask()}
        title="New task (⌘N)"
      >
        <WorkspaceIcon name="compose" />
        <span className="task-tree-title">New task</span>
        <kbd className="ui-kbd">⌘N</kbd>
      </button>
      {searchOpen && (
        <div className="task-tree-search" ref={searchField}>
          <WorkspaceIcon name="search" />
          <TextField
            label="Search tasks"
            placeholder="Search tasks"
            appearance="plain"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setSearch('');
                setSearchOpen(false);
                root.current
                  ?.querySelector<HTMLButtonElement>('[aria-label="Search tasks"]')
                  ?.focus();
              }
            }}
          />
        </div>
      )}
      <nav className="task-tree-list" aria-label="Projects and tasks" data-resource-list>
        {!loaded && !error ? <Skeleton variant="sidebar" label="Loading tasks" /> : null}
        {error && (
          <div className="task-tree-empty" role="alert">
            {error}
            <IconButton icon="refresh" label="Retry" onClick={retry} />
          </div>
        )}
        {loaded &&
          !groups.length &&
          (searching ? (
            <div className="task-tree-empty" role="status">
              No matching tasks
              <Button variant="link" onClick={clearSearch}>
                Clear search
              </Button>
            </div>
          ) : (
            <div className="task-tree-empty">
              No projects or tasks yet.
              <div>
                <Button variant="link" onClick={() => newTask()}>
                  New task
                </Button>
                <Button variant="link" onClick={addRepository}>
                  Add repository
                </Button>
              </div>
            </div>
          ))}
        {actionError && (
          <p role="alert" className="task-tree-empty">
            {actionError}
          </p>
        )}
        {undo && (
          <div role="status" className="task-tree-undo">
            Marked done ·{' '}
            <Button
              variant="link"
              disabled={pending === undo}
              onClick={() => void close(undo, false)}
            >
              Undo
            </Button>
          </div>
        )}
        {pinnedTasks.length > 0 && (
          <>
            <h3 className="task-tree-section">Pinned</h3>
            <ul>{pinnedTasks.map((task) => renderTask(task, false, true))}</ul>
          </>
        )}
        <h3 className="task-tree-section">{attentionOnly ? 'Needs you' : 'Projects'}</h3>
        <ul>
          {groups.map((group) => {
            const isExpanded = searching || expanded[group.id] === true;
            const listId = `${id}-project-${encodeURIComponent(group.id)}`;
            // Selection never changes the project preview or shifts Recents.
            const visible = projectTaskPreview(
              group.tasks,
              searching || showAll[group.id] === true,
            );
            return (
              <li key={group.id} className="task-tree-group">
                <div
                  className="task-tree-project"
                  data-idle={
                    idleProject(
                      tasks.filter((task) => (task.projectId || '') === group.id),
                      now,
                    ) || undefined
                  }
                  data-selected={group.tasks.some((task) => task.id === selected) || undefined}
                >
                  <Button
                    variant="quiet"
                    className="task-tree-toggle"
                    aria-expanded={isExpanded}
                    aria-disabled={searching || undefined}
                    aria-controls={listId}
                    onClick={() => {
                      if (!searching)
                        setExpanded((prior) => ({ ...prior, [group.id]: !isExpanded }));
                    }}
                  >
                    <WorkspaceIcon name="folder" />
                    <span className="task-tree-title">{group.name}</span>
                    <span className="task-tree-signal">{glyph(group.tasks)}</span>
                    <WorkspaceIcon
                      name="chevron"
                      className={`${isExpanded ? 'is-expanded' : ''} ${projectDisclosureShown(isExpanded, group.tasks.length) ? 'is-shown' : ''}`}
                    />
                  </Button>
                  <IconButton
                    icon="plus"
                    label={`New task in ${group.name}`}
                    className="task-tree-add"
                    onClick={() => newTask(group.id)}
                  />
                </div>
                <div
                  className="task-tree-children"
                  data-expanded={isExpanded}
                  inert={!isExpanded}
                  aria-hidden={!isExpanded}
                >
                  <ul id={listId}>
                    {visible.map((task) => {
                      return renderTask(task);
                    })}
                    {!searching && group.tasks.length > visibleLimit && (
                      <li>
                        <Button
                          variant="link"
                          className="task-tree-more"
                          aria-label={
                            showAll[group.id]
                              ? `Show fewer tasks in ${group.name}`
                              : `Show all ${group.tasks.length} tasks in ${group.name}`
                          }
                          onClick={() =>
                            setShowAll((prior) => ({ ...prior, [group.id]: !prior[group.id] }))
                          }
                        >
                          {showAll[group.id] ? 'Show less' : 'Show more'}
                        </Button>
                      </li>
                    )}
                  </ul>
                </div>
              </li>
            );
          })}
        </ul>
        <h3 className="task-tree-section">
          <button
            className="task-tree-recents-toggle"
            aria-expanded={!recentsCollapsed}
            aria-controls={`${id}-recents`}
            onClick={collapseRecents}
          >
            Recents{' '}
            <WorkspaceIcon name="chevron" className={!recentsCollapsed ? 'is-expanded' : ''} />
          </button>
        </h3>
        <div id={`${id}-recents`} hidden={recentsCollapsed}>
          <ul>
            {(allRecents || searching ? recents : recents.slice(0, 8)).map((task) =>
              renderTask(task, true),
            )}
          </ul>
          {!searching && recents.length > 8 && (
            <Button
              variant="link"
              className="task-tree-more"
              onClick={() => setAllRecents(!allRecents)}
            >
              {allRecents ? 'Show less' : 'Show more'}
            </Button>
          )}
          {loaded && !recents.length && (
            <p className="task-tree-empty">
              {attentionOnly ? 'Nothing needs you right now.' : 'No recent tasks.'}
            </p>
          )}
        </div>
      </nav>
    </div>
  );
}
