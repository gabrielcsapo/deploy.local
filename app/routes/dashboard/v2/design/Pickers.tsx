'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@/components/ui';
import type { Project } from '../../../../../shared/v2/contracts';
import { useData } from '../projects/data';
import type { Design } from './model';

/** A popover that closes on a click elsewhere or Escape. */
function Popover({
  open,
  onClose,
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.parentElement?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', escape);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={box} className="dz-picker" role="menu" aria-label={label}>
      {children}
    </div>
  );
}

function Choice({
  on,
  icon,
  title,
  sub,
  end,
  muted,
  onClick,
}: {
  on?: boolean;
  icon: 'folder' | 'branch' | 'plus';
  title: string;
  sub?: string;
  end?: ReactNode;
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={Boolean(on)}
      className={`dz-picker-item${on ? ' on' : ''}${muted ? ' muted' : ''}`}
      onClick={onClick}
    >
      <span className="dz-picker-check">{on && <Icon name="check" size={12} />}</span>
      <Icon name={icon} size={13} />
      <span className="dz-picker-text">
        <b>{title}</b>
        {sub && <small>{sub}</small>}
      </span>
      {end}
    </button>
  );
}

/** Each project with how many boards its design has on main; ones without one say so. */
export function useDesignProjects() {
  return useData<{ projects: { id: string; name: string; boards: number }[] }>(
    '/api/design/projects',
  ).data?.projects;
}

export function ProjectList({
  projects,
  current,
  onProject,
}: {
  projects: Project[];
  current: string | undefined;
  onProject: (id: string) => void;
}) {
  const designs = useDesignProjects();
  const boards = new Map(designs?.map((item) => [item.id, item.boards]));
  return (
    <>
      {projects.map((item) => {
        const count = boards.get(item.id);
        return (
          <Choice
            key={item.id}
            on={item.id === current}
            icon="folder"
            title={item.name}
            sub={
              count === undefined
                ? undefined
                : count
                  ? `${count} board${count === 1 ? '' : 's'}`
                  : 'No design yet'
            }
            muted={count === 0}
            onClick={() => onProject(item.id)}
          />
        );
      })}
      <p className="dz-picker-note">A project gets a design when it has design/canvas.json.</p>
    </>
  );
}

/** The versions of this design: main, then its design branches, newest first. */
export function BranchList({
  branches,
  current,
  owner,
  reviewing,
  onRef,
  onNewBranch,
}: {
  branches: Design['branches'];
  current: string;
  owner: string;
  /** Branches with a design review waiting. */
  reviewing: Set<string>;
  onRef: (ref: string) => void;
  onNewBranch: () => void;
}) {
  const edits = (n = 0) => `${n} edit${n === 1 ? '' : 's'}`;
  return (
    <>
      <Choice
        on={current === 'HEAD'}
        icon="branch"
        title="main"
        sub="The approved design"
        onClick={() => onRef('HEAD')}
      />
      {branches.map((branch) => (
        <Choice
          key={branch.name}
          on={current === branch.name}
          icon="branch"
          title={branch.name}
          sub={
            branch.by && branch.by !== owner
              ? `${edits(branch.edits)} · ${branch.by}`
              : `${edits(branch.edits)}${branch.by ? ' · yours' : ''}`
          }
          end={
            reviewing.has(branch.name) ? <span className="dz-review">In review</span> : undefined
          }
          onClick={() => onRef(branch.name)}
        />
      ))}
      <hr />
      <Choice
        icon="plus"
        title="New branch…"
        end={<span className="dz-meta">from {current === 'HEAD' ? 'main' : 'this one'}</span>}
        onClick={onNewBranch}
      />
    </>
  );
}

/** The project name, opening the projects. */
export function ProjectPicker({
  projects,
  project,
  onProject,
}: {
  projects: Project[];
  project: Project | undefined;
  onProject: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="dz-picker-wrap">
      <button
        type="button"
        className={`dz-project${open ? ' open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {project?.name ?? 'Choose a project'}
        <Icon name="down" size={12} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} label="Projects">
        <div className="dz-picker-label">Projects</div>
        <ProjectList
          projects={projects}
          current={project?.id}
          onProject={(id) => {
            setOpen(false);
            onProject(id);
          }}
        />
      </Popover>
    </span>
  );
}

/** The branch line, opening the versions of this design. */
export function BranchPicker({
  branches,
  current,
  owner,
  reviewing,
  changed,
  onRef,
  onNewBranch,
}: {
  branches: Design['branches'];
  current: string;
  owner: string;
  reviewing: Set<string>;
  /** Boards changed on the branch on screen. */
  changed: number;
  onRef: (ref: string) => void;
  onNewBranch: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="dz-picker-wrap">
      <button
        type="button"
        className={`dz-branch${open ? ' open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="branch" size={11} />
        <span className="dz-t">
          {current === 'HEAD' ? 'main' : current}
          {changed > 0 && ` · ${changed} changed`}
        </span>
        <Icon name="down" size={10} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} label="Versions of this design">
        <div className="dz-picker-label">Versions of this design</div>
        <BranchList
          branches={branches}
          current={current}
          owner={owner}
          reviewing={reviewing}
          onRef={(ref) => {
            setOpen(false);
            onRef(ref);
          }}
          onNewBranch={() => {
            setOpen(false);
            onNewBranch();
          }}
        />
      </Popover>
    </span>
  );
}

/**
 * On a phone, one sheet picks where you are: the project, the version of its design and the page.
 */
export function PickSheet({
  open,
  onClose,
  first,
  projects,
  project,
  onProject,
  branches,
  current,
  owner,
  reviewing,
  onRef,
  onNewBranch,
  sections,
  section,
  onSection,
}: {
  open: boolean;
  onClose: () => void;
  /** The part the sheet opens on. */
  first: 'project' | 'branch' | 'page';
  projects: Project[];
  project: Project | undefined;
  onProject: (id: string) => void;
  branches: Design['branches'];
  current: string;
  owner: string;
  reviewing: Set<string>;
  onRef: (ref: string) => void;
  onNewBranch: () => void;
  sections: { id: string; title: string; boards: string[] }[];
  section: { id: string } | null;
  onSection: (id: string) => void;
}) {
  const [part, setPart] = useState(first);
  useEffect(() => {
    if (open) setPart(first);
  }, [open, first]);
  if (!open) return null;
  const done =
    <T,>(run: (value: T) => void) =>
    (value: T) => {
      onClose();
      run(value);
    };
  return (
    <>
      <div className="dz-picksheet-dim" onClick={onClose} />
      <div className="dz-picksheet" role="dialog" aria-label="Choose a project, branch or page">
        <button type="button" className="dz-grab-button" aria-label="Close" onClick={onClose}>
          <span className="dz-grab" />
        </button>
        <b className="dz-picksheet-title">{project?.name ?? 'Designs'}</b>
        <div className="dz-picksheet-seg" role="tablist">
          {(['project', 'branch', 'page'] as const).map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={part === name}
              className={part === name ? 'on' : ''}
              onClick={() => setPart(name)}
            >
              {name[0].toUpperCase() + name.slice(1)}
            </button>
          ))}
        </div>
        <div className="dz-picksheet-list">
          {part === 'project' && (
            <ProjectList projects={projects} current={project?.id} onProject={done(onProject)} />
          )}
          {part === 'branch' && (
            <BranchList
              branches={branches}
              current={current}
              owner={owner}
              reviewing={reviewing}
              onRef={done(onRef)}
              onNewBranch={() => {
                onClose();
                onNewBranch();
              }}
            />
          )}
          {part === 'page' &&
            sections.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitemradio"
                aria-checked={item.id === section?.id}
                className={`dz-picker-item${item.id === section?.id ? ' on' : ''}`}
                onClick={() => done(onSection)(item.id)}
              >
                <span className="dz-picker-check">
                  {item.id === section?.id && <Icon name="check" size={12} />}
                </span>
                <Icon name="layers" size={13} />
                <span className="dz-picker-text">
                  <b>{item.title}</b>
                  <small>
                    {item.boards.length} board{item.boards.length === 1 ? '' : 's'}
                  </small>
                </span>
              </button>
            ))}
        </div>
      </div>
    </>
  );
}
