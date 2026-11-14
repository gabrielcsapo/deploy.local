'use client';
import { useEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { Icon, Nav } from '@/components/ui';
import {
  PROJECT_TASKS_SHOWN,
  taskState,
  taskWorking,
  tasksByProject,
  type SidebarTask,
  type WorkspaceState,
} from './data/sidebar';
import {
  rememberTaskGrouping,
  taskGrouping,
  taskGroupingEvent,
  taskGroupingKey,
  type TaskGrouping,
} from './data/sidebar-preference';
import { DeleteTaskDialog } from './tasks/DeleteTaskDialog';

type FormatTime = (value: string, style: 'day' | 'list') => string;

/** A menu closes when focus leaves it and its trigger, and on Escape, which returns focus. */
function dismiss(close: () => void, trigger?: { current: HTMLElement | null }) {
  return {
    onBlur(event: FocusEvent<HTMLElement>) {
      if (!event.currentTarget.contains(event.relatedTarget)) close();
    },
    onKeyDown(event: { key: string; stopPropagation(): void }) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
      trigger?.current?.focus();
    },
  };
}
const focusFirst = (node: HTMLElement | null) =>
  node?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();

/** The grouping choice, the same in the sidebar and the drawer, remembered by this browser. */
function useTaskGrouping() {
  const [grouping, setGrouping] = useState<TaskGrouping>('date');
  useEffect(() => {
    const read = () => setGrouping(taskGrouping());
    read();
    const stored = (event: StorageEvent) => {
      if (event.key === taskGroupingKey || event.key === null) read();
    };
    window.addEventListener('storage', stored);
    window.addEventListener(taskGroupingEvent, read);
    return () => {
      window.removeEventListener('storage', stored);
      window.removeEventListener(taskGroupingEvent, read);
    };
  }, []);
  return [
    grouping,
    (next: TaskGrouping) => {
      rememberTaskGrouping(next);
      setGrouping(next);
      window.dispatchEvent(new Event(taskGroupingEvent));
    },
  ] as const;
}

/** The sidebar's task list: by day (Today, Yesterday) or by project. */
export function SidebarTasks({
  pathname,
  workspace,
  formatTime,
}: {
  pathname: string;
  workspace: WorkspaceState | null;
  formatTime: FormatTime;
}) {
  const [grouping, setGrouping] = useTaskGrouping();
  const [groupMenu, setGroupMenu] = useState(false);
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null);
  const groupList = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (groupMenu) focusFirst(groupList.current);
  }, [groupMenu]);
  const runs = workspace?.runs ?? [];
  const tasks = [...(workspace?.tasks ?? [])].sort(
    (a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt),
  );

  const groupTrigger = useRef<HTMLButtonElement>(null);
  const closeGroupMenu = () => setGroupMenu(false);
  // The group button and its menu sit on the list's first heading.
  const heading = (label: ReactNode, first: boolean, actions?: ReactNode) => {
    const head = (
      <div className="dl-side-label">
        <span>{label}</span>
        {(first || actions) && (
          <span className="side-label-actions">
            {first && (
              <button
                ref={groupTrigger}
                type="button"
                className={`dl-icon-btn sm${groupMenu ? ' on' : ''}`}
                aria-label="Group tasks"
                aria-haspopup="menu"
                aria-expanded={groupMenu}
                onClick={() => setGroupMenu(!groupMenu)}
              >
                <Icon name="group" size={14} />
              </button>
            )}
            {actions}
          </span>
        )}
      </div>
    );
    if (!first) return head;
    return (
      <div {...dismiss(() => groupMenu && closeGroupMenu(), groupTrigger)}>
        {head}
        {groupMenu && (
          <div className="side-anchor">
            <div className="dl-menu" role="menu" aria-label="Group tasks by" ref={groupList}>
              <span className="dl-menu-label">Group tasks by</span>
              {(
                [
                  ['date', 'Date'],
                  ['project', 'Project'],
                ] as const
              ).map(([value, name]) => (
                <button
                  key={value}
                  type="button"
                  className="dl-menu-item"
                  role="menuitemradio"
                  aria-checked={grouping === value}
                  onClick={() => {
                    setGrouping(value);
                    closeGroupMenu();
                    // The button moves to the new first heading; focus it once it is there.
                    requestAnimationFrame(() => groupTrigger.current?.focus());
                  }}
                >
                  {name}
                  {grouping === value && (
                    <span className="dl-end">
                      <Icon name="tick" size={14} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };
  const row = (task: SidebarTask, end?: string) => (
    <TaskRow
      key={task.id}
      task={task}
      pathname={pathname}
      state={taskState(task, runs)}
      working={taskWorking(task, runs)}
      end={end}
      open={rowMenu === task.id}
      onMenu={(open) => setRowMenu(open ? task.id : null)}
      onDelete={() => {
        setRowMenu(null);
        setDeleting({ id: task.id, title: task.title });
      }}
    />
  );

  let list: ReactNode;
  if (grouping === 'project') {
    const groups = tasksByProject(tasks, workspace?.projects ?? []);
    list = groups.map((group, index) => {
      const key = group.project?.id ?? '';
      const more = group.tasks.length - PROJECT_TASKS_SHOWN;
      const shown =
        more > 0 && !expanded.includes(key)
          ? group.tasks.slice(0, PROJECT_TASKS_SHOWN)
          : group.tasks;
      return (
        <div key={key}>
          {heading(group.project?.name ?? 'No project', index === 0)}
          {shown.map((task) => row(task, formatTime(task.updatedAt || task.createdAt, 'list')))}
          {shown.length < group.tasks.length && (
            <button
              type="button"
              className="dl-nav side-more"
              onClick={() => setExpanded([...expanded, key])}
            >
              <span className="dl-t">Show {more} more</span>
            </button>
          )}
        </div>
      );
    });
  } else {
    let first = true;
    list = ['Today', 'Yesterday'].map((day) => {
      const items = tasks.filter(
        (task) => formatTime(task.updatedAt || task.createdAt, 'day') === day,
      );
      if (!items.length) return null;
      const isFirst = first;
      first = false;
      return (
        <div key={day}>
          {heading(
            day,
            isFirst,
            day === 'Today' && (
              <a href="/dashboard" className="dl-icon-btn sm" aria-label="New task">
                <Icon name="plus" size={14} />
              </a>
            ),
          )}
          {items.map((task) =>
            row(
              task,
              day === 'Today' ? formatTime(task.updatedAt || task.createdAt, 'list') : undefined,
            ),
          )}
        </div>
      );
    });
  }
  return (
    <>
      {list}
      <DeleteTaskDialog task={deleting} onClose={() => setDeleting(null)} />
    </>
  );
}

function TaskRow({
  task,
  pathname,
  state,
  working,
  end,
  open,
  onMenu,
  onDelete,
}: {
  task: SidebarTask;
  pathname: string;
  state: ReturnType<typeof taskState>;
  working: boolean;
  end?: string;
  open: boolean;
  onMenu: (open: boolean) => void;
  onDelete: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) focusFirst(menu.current);
  }, [open]);
  // A running task has no actions: it is stopped before it is deleted.
  const actions = !working;
  const href = `/dashboard/tasks/${encodeURIComponent(task.id)}`;
  return (
    <div
      className={`side-task${open ? ' open' : ''}`}
      onContextMenu={(event) => {
        if (!actions) return;
        event.preventDefault();
        onMenu(true);
      }}
      {...dismiss(() => open && onMenu(false), trigger)}
    >
      <Nav
        href={href}
        active={pathname.startsWith(href)}
        lead={
          state === 'idle' ? undefined : (
            <span
              aria-label={state === 'stalled' ? 'Stalled' : state === 'ready' ? 'Ready' : 'Running'}
            >
              <Icon
                name={state === 'running' ? 'running' : state === 'ready' ? 'check' : 'clock'}
                className={
                  state === 'running'
                    ? 'dl-run dl-spin'
                    : state === 'ready'
                      ? 'dl-ok'
                      : 'dl-stalled'
                }
                size={14}
              />
            </span>
          )
        }
        end={end}
      >
        {task.title}
      </Nav>
      {actions && (
        <button
          ref={trigger}
          type="button"
          className="dl-icon-btn sm side-task-more"
          aria-label="Task actions"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => onMenu(!open)}
        >
          <Icon name="more" />
        </button>
      )}
      {actions && open && (
        <div className="side-anchor">
          <div className="dl-menu" role="menu" aria-label="Task actions" ref={menu}>
            <button
              type="button"
              className="dl-menu-item danger"
              role="menuitem"
              onClick={onDelete}
            >
              Delete task…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
