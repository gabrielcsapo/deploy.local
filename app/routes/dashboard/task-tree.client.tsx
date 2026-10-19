'use client';

import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Link } from 'react-flight-router/client';
import { Button, StatusBadge, TextField, WorkspaceIcon } from '@/components/ui';
import { taskAge, taskStatus, taskTree, type TreeProject, type TreeTask } from './task-tree';
import './task-tree.css';

type Task = TreeTask & { status: string };
const expansionKey = 'workspace-task-tree-expanded';

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
}) {
  const id = useId();
  const searchField = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
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
  const groups = useMemo(() => taskTree(projects, tasks, search), [projects, tasks, search]);
  const searching = Boolean(search.trim());
  function clearSearch() {
    setSearch('');
    searchField.current?.querySelector('input')?.focus();
  }
  function selectTask(event: MouseEvent<HTMLAnchorElement>, taskId: string) {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openTask(taskId);
  }
  return (
    <div className="task-tree-navigation">
      <div className="task-tree-search" ref={searchField}>
        <WorkspaceIcon name="search" />
        <TextField
          label="Search tasks"
          placeholder="Search tasks"
          appearance="plain"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <nav className="task-tree-list" aria-label="Projects and tasks" data-resource-list>
        {!loaded && !error ? (
          <p className="task-tree-empty" role="status">
            Loading tasks…
          </p>
        ) : null}
        {error && (
          <div className="task-tree-empty" role="alert">
            {error}
            <Button variant="quiet" onClick={retry}>
              Retry
            </Button>
          </div>
        )}
        {loaded &&
          !groups.length &&
          (searching ? (
            <div className="task-tree-empty" role="status">
              No matching tasks
              <Button variant="quiet" onClick={clearSearch}>
                Clear search
              </Button>
            </div>
          ) : (
            <div className="task-tree-empty">
              No projects or tasks yet.
              <div>
                <Button variant="quiet" onClick={() => newTask()}>
                  New task
                </Button>
                <Button variant="quiet" onClick={addRepository}>
                  Add repository
                </Button>
              </div>
            </div>
          ))}
        <ul>
          {groups.map((group) => {
            const isExpanded = searching || expanded[group.id] !== false;
            const listId = `${id}-project-${encodeURIComponent(group.id)}`;
            return (
              <li key={group.id}>
                <div className="task-tree-project">
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
                    <WorkspaceIcon name="chevron" className={isExpanded ? 'is-expanded' : ''} />
                    <WorkspaceIcon name="folder" />
                    <span className="task-tree-title">{group.name}</span>
                    {!isExpanded && (
                      <span className="task-tree-count" aria-label={`${group.count} tasks`}>
                        {group.count}
                      </span>
                    )}
                  </Button>
                  <Button
                    variant="quiet"
                    className="task-tree-add"
                    aria-label={`New task in ${group.name}`}
                    onClick={() => newTask(group.id)}
                  >
                    <WorkspaceIcon name="plus" />
                  </Button>
                </div>
                <ul id={listId} hidden={!isExpanded}>
                  {group.tasks.map((task) => {
                    const age = taskAge(task.updatedAt, now);
                    const status = taskStatus(task.status, waitingForAnswer.has(task.id));
                    return (
                      <li key={task.id}>
                        <Link
                          to="/dashboard"
                          className="task-tree-task"
                          aria-current={selected === task.id ? 'page' : undefined}
                          aria-label={`${task.title}, ${status.label}, ${age.label}`}
                          title={`${task.title} — ${status.label}. ${age.label}`}
                          onClick={(event) => selectTask(event, task.id)}
                        >
                          <span className="task-tree-status" aria-hidden="true">
                            <StatusBadge tone={status.tone} label={status.label} />
                          </span>
                          <span className="task-tree-title">{task.title}</span>
                          <span className="task-tree-age" aria-hidden="true">
                            {age.compact}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                  {!group.tasks.length && <li className="task-tree-no-tasks">No tasks yet</li>}
                </ul>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
