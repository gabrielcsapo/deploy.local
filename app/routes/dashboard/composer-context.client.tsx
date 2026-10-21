'use client';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../components/ui/index';
import { WorkspaceIcon } from './workspace-icon';
import type { ComputerRole } from '../../../server/computer-roles';

type Project = { id: string; name: string };
type Computer = {
  id: string;
  name?: string;
  platform?: string;
  status: string;
  roles?: { tasks?: ComputerRole };
};

function ContextPicker({
  label,
  value,
  icon,
  quiet = false,
  children,
}: {
  label: string;
  value: string;
  icon: string;
  quiet?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const id = useId();
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const dismiss = (event: Event) => {
      if (!(event.target instanceof Node) || !popup.current?.contains(event.target))
        popup.current?.hidePopover();
    };
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, []);
  const close = () => {
    popup.current?.hidePopover();
    trigger.current?.focus();
  };
  return (
    <div className="pw-context-picker">
      <button
        type="button"
        ref={trigger}
        className={`pw-model-pill${quiet ? ' pw-context-unset' : ''}`}
        popoverTarget={id}
        aria-label={`${label}: ${value}`}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <WorkspaceIcon name={icon} />
        <span className="pw-model-name">{value}</span>
        <WorkspaceIcon name="chevron-down" className="pw-control-chevron" />
      </button>
      <div
        ref={popup}
        id={id}
        popover="auto"
        role="dialog"
        aria-label={`Choose ${label.toLowerCase()}`}
        className="pw-model-popover pw-context-popover"
        onToggle={(event) => {
          const isOpen = event.newState === 'open';
          setOpen(isOpen);
          const rect = trigger.current?.getBoundingClientRect();
          if (!isOpen || !rect || !popup.current) return;
          Object.assign(popup.current.style, {
            left: `${Math.max(0, Math.min(rect.left, window.innerWidth - popup.current.offsetWidth))}px`,
            bottom: `${window.innerHeight - rect.top}px`,
            maxHeight: `calc(${rect.top}px - var(--ds-space-4))`,
          });
          popup.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
        }}
        onKeyDown={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
          ];
          if (!buttons.length) return;
          event.preventDefault();
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }}
      >
        {children(close)}
      </div>
    </div>
  );
}

export function ComposerContext({
  projects,
  project,
  computers,
  computer,
  chooseProject,
  chooseComputer,
  newRepository,
}: {
  projects: Project[];
  project: string;
  computers: Computer[];
  computer: string;
  chooseProject: (id: string) => void;
  chooseComputer: (id: string) => void;
  newRepository: () => void;
}) {
  const taskComputers = computers.filter(
    (item) => item.roles?.tasks && item.roles.tasks.state !== 'off',
  );
  return (
    <>
      <ContextPicker
        label="Project"
        value={projects.find((item) => item.id === project)?.name || 'No project'}
        quiet={!project}
        icon="folder"
      >
        {(close) => (
          <>
            <div className="pw-model-list">
              {[{ id: '', name: 'No project' }, ...projects].map((item) => (
                <button
                  type="button"
                  key={item.id}
                  aria-pressed={item.id === project}
                  onClick={() => {
                    chooseProject(item.id);
                    close();
                  }}
                >
                  <span>{item.name}</span>
                  {item.id === project && <WorkspaceIcon name="check" />}
                </button>
              ))}
            </div>
            <div className="pw-context-create">
              <Button
                variant="link"
                onClick={() => {
                  close();
                  newRepository();
                }}
              >
                New repository…
              </Button>
            </div>
          </>
        )}
      </ContextPicker>
      <ContextPicker
        label="Computer"
        value={computers.find((item) => item.id === computer)?.name || computer}
        icon="computer"
      >
        {(close) => (
          <div className="pw-model-list">
            {taskComputers.map((item) => {
              const role = item.roles!.tasks!;
              const disabled = item.status !== 'online' || role.state !== 'ready';
              const reason =
                item.status !== 'online'
                  ? 'Offline'
                  : role.state === 'paused'
                    ? 'Paused'
                    : 'Needs setup';
              const glyph =
                item.platform === 'darwin'
                  ? 'platform-mac'
                  : item.platform === 'linux'
                    ? 'platform-linux'
                    : item.platform === 'win32'
                      ? 'platform-windows'
                      : 'computer';
              return (
                <button
                  type="button"
                  key={item.id}
                  disabled={disabled}
                  aria-pressed={item.id === computer}
                  onClick={() => {
                    chooseComputer(item.id);
                    close();
                  }}
                >
                  <span className="pw-computer-choice">
                    <span
                      className="ui-status-badge"
                      data-tone={
                        disabled ? (item.status !== 'online' ? 'inactive' : 'attention') : 'healthy'
                      }
                      aria-hidden="true"
                    >
                      <span className="ui-status-dot" />
                    </span>
                    <span role="img" aria-label={item.platform || 'Unknown platform'}>
                      <WorkspaceIcon name={glyph} />
                    </span>
                    <span>
                      {item.name || item.id}
                      {disabled && (
                        <small>
                          {reason}
                          {role.state !== 'ready' && role.reason ? ` · ${role.reason}` : ''}
                        </small>
                      )}
                    </span>
                  </span>
                  {item.id === computer && <WorkspaceIcon name="check" />}
                </button>
              );
            })}
            {!taskComputers.length && (
              <p className="pw-muted">No computers with Coding tasks enabled.</p>
            )}
          </div>
        )}
      </ContextPicker>
    </>
  );
}
