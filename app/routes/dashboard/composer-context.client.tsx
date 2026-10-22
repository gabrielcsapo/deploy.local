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
  desktopOnly = false,
  children,
}: {
  label: string;
  value: string;
  icon: string;
  quiet?: boolean;
  desktopOnly?: boolean;
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
    <div className={`pw-context-picker${desktopOnly ? ' desktop-only' : ''}`}>
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

type ContextProps = {
  projects: Project[];
  project: string;
  computers: Computer[];
  computer: string;
  chooseProject: (id: string) => void;
  chooseComputer: (id: string) => void;
  newRepository: () => void;
};

function ProjectChoices({
  projects,
  project,
  chooseProject,
  newRepository,
}: Pick<ContextProps, 'projects' | 'project' | 'chooseProject' | 'newRepository'>) {
  return (
    <>
      <div className="pw-model-list">
        {[{ id: '', name: 'No project' }, ...projects].map((item) => (
          <button
            type="button"
            key={item.id}
            aria-pressed={item.id === project}
            onClick={() => chooseProject(item.id)}
          >
            <span>{item.name}</span>
            {item.id === project && <WorkspaceIcon name="check" />}
          </button>
        ))}
      </div>
      <div className="pw-context-create">
        <Button variant="link" onClick={newRepository}>
          New repository…
        </Button>
      </div>
    </>
  );
}

function ComputerChoices({
  computers,
  computer,
  chooseComputer,
}: Pick<ContextProps, 'computers' | 'computer' | 'chooseComputer'>) {
  const taskComputers = computers.filter(
    (item) => item.roles?.tasks && item.roles.tasks.state !== 'off',
  );
  return (
    <div className="pw-model-list">
      {taskComputers.map((item) => {
        const role = item.roles!.tasks!;
        const disabled = item.status !== 'online' || role.state !== 'ready';
        const reason =
          item.status !== 'online' ? 'Offline' : role.state === 'paused' ? 'Paused' : 'Needs setup';
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
            onClick={() => chooseComputer(item.id)}
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
      {!taskComputers.length && <p className="pw-muted">No computers with Coding tasks enabled.</p>}
    </div>
  );
}

export function ComposerContext(props: ContextProps & { desktopOnly?: boolean }) {
  return (
    <>
      <ContextPicker
        label="Project"
        value={props.projects.find((item) => item.id === props.project)?.name || 'No project'}
        quiet={!props.project}
        icon="folder"
        desktopOnly={props.desktopOnly}
      >
        {(close) => (
          <ProjectChoices
            {...props}
            chooseProject={(id) => {
              props.chooseProject(id);
              close();
            }}
            newRepository={() => {
              close();
              props.newRepository();
            }}
          />
        )}
      </ContextPicker>
      <ContextPicker
        label="Computer"
        value={props.computers.find((item) => item.id === props.computer)?.name || props.computer}
        icon="computer"
        desktopOnly={props.desktopOnly}
      >
        {(close) => (
          <ComputerChoices
            {...props}
            chooseComputer={(id) => {
              props.chooseComputer(id);
              close();
            }}
          />
        )}
      </ContextPicker>
    </>
  );
}

export function PhoneComposerContext({
  followUp = false,
  modelControls,
  ...props
}: ContextProps & {
  followUp?: boolean;
  modelControls: ReactNode;
}) {
  const id = useId();
  const sheet = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const computer =
    props.computers.find((item) => item.id === props.computer)?.name || props.computer;
  const project = props.projects.find((item) => item.id === props.project)?.name || 'No project';
  const close = () => sheet.current?.close();
  useEffect(() => {
    const media = matchMedia('(width < 640px)');
    const dismiss = () => {
      if (!media.matches) sheet.current?.close();
    };
    media.addEventListener('change', dismiss);
    return () => media.removeEventListener('change', dismiss);
  }, []);
  useEffect(() => {
    sheet.current?.close();
  }, [followUp]);
  return (
    <div className="pw-phone-context phone-only">
      <button
        type="button"
        ref={trigger}
        className="pw-model-pill pw-phone-context-chip"
        aria-label={
          followUp
            ? 'Model. Change'
            : `Computer ${computer}, project ${props.project ? project : 'none'}. Change`
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          sheet.current?.showModal();
          setOpen(true);
        }}
      >
        <span className="pw-model-name">{followUp ? 'Model' : `${computer} · ${project}`}</span>
        <WorkspaceIcon name="chevron-down" className="pw-control-chevron" />
      </button>
      <dialog
        ref={sheet}
        id={id}
        className="pw-phone-context-sheet"
        aria-labelledby={`${id}-title`}
        onClose={() => {
          setOpen(false);
          if (!document.querySelector('dialog[open]')) trigger.current?.focus();
        }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            close();
        }}
      >
        <div className="pw-phone-sheet-handle" aria-hidden="true" />
        <header>
          <h2 id={`${id}-title`}>{followUp ? 'Task options' : 'Task context'}</h2>
          <Button variant="link" onClick={close}>
            Done
          </Button>
        </header>
        <div className="pw-phone-sheet-body">
          {!followUp && (
            <>
              <section aria-labelledby={`${id}-computer`}>
                <h3 id={`${id}-computer`}>Computer</h3>
                <ComputerChoices {...props} />
              </section>
              <section aria-labelledby={`${id}-project`}>
                <h3 id={`${id}-project`}>Project</h3>
                <ProjectChoices
                  {...props}
                  newRepository={() => {
                    close();
                    props.newRepository();
                  }}
                />
              </section>
            </>
          )}
          <section aria-labelledby={`${id}-model`}>
            <h3 id={`${id}-model`}>Model</h3>
            {modelControls}
          </section>
        </div>
      </dialog>
    </div>
  );
}

export function NewTaskPrompt(props: ContextProps) {
  const name = props.projects.find((item) => item.id === props.project)?.name;
  return (
    <div className="pw-new-task-prompt">
      <WorkspaceIcon name="brand" />
      <h1>
        What should we build
        {name ? (
          <>
            {' '}
            in{' '}
            <Button
              variant="link"
              onClick={(event) => {
                event.currentTarget
                  .closest('.pw-chat, .ds-chrome-specimen')
                  ?.querySelector<HTMLButtonElement>(
                    '.pw-composer-context-tray button[aria-label^="Project:"]',
                  )
                  ?.click();
              }}
            >
              {name}
            </Button>
          </>
        ) : null}
        ?
      </h1>
    </div>
  );
}
