'use client';
import { ActionCluster, IconButton } from '@/components/ui';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Link } from 'react-flight-router/client';
import { Button, TextField, WorkspaceIcon } from '@/components/ui';
import { taskAge, taskStatus, taskTree, type TreeProject, type TreeTask } from './task-tree';
import './task-tree.css';

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
  newTask,
  addRepository,
  retry,
  shortcuts = true,
}: {
  projects: TreeProject[];
  tasks: Task[];
  selected: string;
  loaded: boolean;
  error: string;
  waitingForAnswer: ReadonlySet<string>;
  openTask: (id: string) => void;
  newTask: (projectId?: string) => void;
  addRepository: () => void;
  retry: () => void;
  shortcuts?: boolean;
}) {
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
  const selectedTask = tasks.find((task) => task.id === selected);
  const selectedGroup = selectedTask
    ? projects.some((project) => project.id === selectedTask.projectId)
      ? selectedTask.projectId || ''
      : ''
    : undefined;
  useEffect(() => {
    if (!restored || selectedGroup === undefined) return;
    setExpanded((prior) => ({ ...prior, [selectedGroup]: true }));
  }, [selected, restored, selectedGroup]);
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
  const running = (task: Task) =>
    ['running', 'starting', 'checking', 'queued'].includes(task.status);
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
  const recents = groups
    .flatMap((group) => group.tasks)
    .sort(
      (a, b) =>
        String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')) ||
        a.id.localeCompare(b.id),
    );
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
  function renderTask(task: Task) {
    const age = taskAge(task.updatedAt, now);
    const status = taskStatus(
      task.status,
      waitingForAnswer.has(task.id),
      task.pull,
      Boolean(task.controlRequest),
    );
    return (
      <li key={task.id}>
        <Link
          to={`/dashboard?task=${encodeURIComponent(task.id)}`}
          className="task-tree-task"
          data-finished={(!running(task) && !blocked(task)) || undefined}
          aria-current={selected === task.id ? 'page' : undefined}
          aria-label={`${task.title}, ${status.label}, ${age.label}`}
          title={`${task.title} — ${status.label}. ${age.label}`}
          onClick={(event) => selectTask(event, task.id)}
        >
          <span className="task-tree-title">{task.title}</span>
          <span className="task-tree-signal" aria-hidden="true">
            {glyph([task])}
          </span>
        </Link>
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
        <kbd>⌘N</kbd>
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
        {!loaded && !error ? (
          <p className="task-tree-empty" role="status">
            Loading tasks…
          </p>
        ) : null}
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
        <h3 className="task-tree-section">{attentionOnly ? 'Needs you' : 'Projects'}</h3>
        <ul>
          {groups.map((group) => {
            const isExpanded = searching || expanded[group.id] === true;
            const listId = `${id}-project-${encodeURIComponent(group.id)}`;
            const limited = !searching && !showAll[group.id] && group.tasks.length > visibleLimit;
            // The first tasks by recent activity; the selected task always stays visible.
            const visible = limited
              ? group.tasks.filter((task, index) => index < visibleLimit || task.id === selected)
              : group.tasks;
            return (
              <li key={group.id} className="task-tree-group">
                <div
                  className="task-tree-project"
                  data-inactive={
                    !group.tasks.some((task) => blocked(task) || running(task)) || undefined
                  }
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
                    <WorkspaceIcon name="chevron" className={isExpanded ? 'is-expanded' : ''} />
                  </Button>
                  <IconButton
                    icon="plus"
                    label={`New task in ${group.name}`}
                    className="task-tree-add"
                    onClick={() => newTask(group.id)}
                  />
                </div>
                <ul id={listId} hidden={!isExpanded}>
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
              </li>
            );
          })}
        </ul>
        <h3 className="task-tree-section">Recents</h3>
        <ul>{(allRecents || searching ? recents : recents.slice(0, 8)).map(renderTask)}</ul>
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
      </nav>
    </div>
  );
}
