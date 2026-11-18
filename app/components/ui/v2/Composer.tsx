'use client';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useDataSeed, readSeeded } from '../../../routes/dashboard/v2/data/seeds';
import { formatTime } from '../../../routes/dashboard/v2/data/time';
import { AgentAvatar } from './AgentAvatar';
import type { AgentConfiguration } from '../../../../shared/v2/contracts';
import { Icon, IconButton, type ComponentState } from './shared';
import { Dialog } from './Dialog';
import { useLocation } from 'react-flight-router/client';
import {
  branchRef,
  chosenProject,
  projectParameter,
} from '../../../routes/dashboard/v2/start/chosen-project';
import type {
  Attachment,
  Computer,
  ComputerModels,
  ModelChoice,
} from '../../../../shared/v2/contracts';
import { MenuRow, MenuSeparator, PopoverMenu, SubMenu } from './ComposerMenu';
import { chipLabel, effortLabel, modelGroups } from './composer-choices';
import {
  mediaRequest,
  submitMessage,
  uploadFile,
  type ComposerMessage,
} from '../../../routes/dashboard/v2/markup/client';
import '../../../routes/dashboard/v2/markup/style.css';

export function Composer({
  project = null,
  computer = null,
  start = false,
  projects: startProjects,
  model = 'Auto',
  disabled,
  loading,
  onSend,
  onAttach,
  onModel,
  onVoice,
  footer,
  suggestedText,
}: ComponentState & {
  /** A fixed project or computer shown as a plain chip, where the composer cannot change it. */
  project?: string | null;
  computer?: string | null;
  /** Starts tasks: the project and computer chips open menus (New task, an empty project). */
  start?: boolean;
  /** The projects a start composer begins with. */
  projects?: string[];
  model?: string;
  onSend?: (text: string, message?: ComposerMessage) => void | Promise<void>;
  onAttach?: () => void;
  onModel?: () => void;
  onVoice?: () => void;
  footer?: ReactNode;
  suggestedText?: { text: string; nonce: number };
}) {
  const seed = useDataSeed();
  const id = useId();
  const location = useLocation();
  const picker = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  useEffect(() => {
    if (suggestedText) setText(suggestedText.text);
  }, [suggestedText]);
  const [agents, setAgents] = useState<AgentConfiguration[]>(
    () => (seed?.data['/api/agents'] as { agents: AgentConfiguration[] } | undefined)?.agents ?? [],
  );
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionClosed, setMentionClosed] = useState(false);
  const mentionQuery = !mentionClosed && text.match(/(?:^|\s)@([^@\n]*)$/)?.[1];
  const matches =
    typeof mentionQuery === 'string'
      ? agents.filter((a) => a.name.toLowerCase().includes(mentionQuery.toLowerCase()))
      : [];
  function chooseMention(agent: AgentConfiguration) {
    setText(text.replace(/@[^@\n]*$/, `@${agent.name} `));
    setMentionClosed(true);
  }
  useEffect(() => {
    readSeeded(seed, '/api/agents', () => mediaRequest('/agents'))
      .then((v) => setAgents(v.agents))
      .catch(() => {});
  }, [seed]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [menu, setMenu] = useState<
    'attach' | 'model' | 'screenshot' | 'project' | 'projects' | 'computers' | null
  >(null);
  const [submenu, setSubmenu] = useState<'effort' | 'more' | null>(null);
  const closeMenu = useCallback(() => {
    setMenu(null);
    setSubmenu(null);
  }, []);
  // A menu closed by pressing on its own button must not open again on that button's click, and
  // one closed by pressing another button must not close the menu that button opens.
  const dismissed = useRef({ which: '', at: 0 });
  const dismiss = useCallback((which: 'model' | 'projects' | 'computers') => {
    dismissed.current = { which, at: Date.now() };
    setMenu((current) => (current === which ? null : current));
    setSubmenu(null);
  }, []);
  function toggleMenu(which: 'model' | 'projects' | 'computers') {
    const recent = dismissed.current.which === which && Date.now() - dismissed.current.at < 400;
    if (menu === which || recent) closeMenu();
    else setMenu(which);
  }
  const closeSubmenu = useCallback(() => setSubmenu(null), []);
  const projectChip = useRef<HTMLButtonElement>(null);
  const computerChip = useRef<HTMLButtonElement>(null);
  const modelButton = useRef<HTMLButtonElement>(null);
  const [projectIds, setProjectIds] = useState<string[]>(startProjects ?? []);
  const [workerIds, setWorkerIds] = useState<string[]>([]);
  const [effort, setEffort] = useState('');
  const [projectQuery, setProjectQuery] = useState('');
  const [projectList, setProjectList] = useState<{ id: string; name: string }[]>(
    () =>
      (seed?.data['/api/projects'] as { projects?: { id: string; name: string }[] } | undefined)
        ?.projects ?? [],
  );
  const [computerList, setComputerList] = useState<Computer[]>([]);
  const [models, setModels] = useState<ComputerModels | null>(
    () => (seed?.data['/api/model-settings'] as ComputerModels) ?? null,
  );
  const [override, setOverride] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [context, setContext] = useState<{
    taskId?: string;
    agentId?: string;
    home?: boolean;
    projectId?: string;
    /** The project a New task link chose for the start page. */
    chosen?: { id: string; name: string };
  }>({});
  const [target, setTarget] = useState('web');
  const [address, setAddress] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [files, setFiles] = useState<any[]>([]);
  const [projectRef, setProjectRef] = useState('HEAD');
  const busy = disabled || loading || pending;
  // A project heading's + opens the start page with its project chosen (?project=<id>).
  const chosenId = projectParameter(location.pathname, location.search);
  // Search's "Ask an agent about…" arrives with the words already written, even on the agent's own page.
  const ask = new URLSearchParams(location.search).get('ask') ?? '';
  useEffect(() => {
    const path = location.pathname;
    setText(ask);
    setAttachments([]);
    setOverride(null);
    setEffort('');
    setProjectIds(startProjects ?? []);
    setWorkerIds([]);
    setError('');
    let active = true;
    const taskId = path.match(/^\/dashboard\/tasks\/([^/]+)/)?.[1];
    const agentId = path.match(/^\/dashboard\/agents\/([^/]+)$/)?.[1];
    const home = path === '/dashboard' || path === '/dashboard/';
    setContext({ taskId, agentId, home });
    if (home && chosenId)
      void readSeeded(seed, '/api/projects', () => mediaRequest('/projects'))
        .then((value: { projects?: { id: string; name: string }[] }) => {
          const chosen = chosenProject(chosenId, value?.projects);
          if (active && chosen) {
            setContext({ home, chosen });
            setProjectIds([chosen.id]);
          }
        })
        .catch(() => {});
    if (taskId)
      void readSeeded(seed, `/api/task-snapshots/${encodeURIComponent(taskId)}`, () =>
        mediaRequest(`/task-snapshots/${encodeURIComponent(taskId)}`),
      )
        .then((value) => {
          if (!active) return;
          setContext({ taskId, projectId: value.project?.id });
          const last = value.screenshots?.at(-1);
          if (last) {
            setTarget(last.target.kind);
            setAddress(last.target.url || last.target.device || '');
          }
        })
        .catch(() => {});
    if (home || start) {
      void readSeeded(seed, '/api/projects', () => mediaRequest('/projects'))
        .then((value: { projects?: { id: string; name: string }[] }) => {
          if (active) setProjectList(value?.projects ?? []);
        })
        .catch(() => {});
      void mediaRequest('/computers')
        .then((value: { computers?: Computer[] }) => {
          if (active) setComputerList(value?.computers ?? []);
        })
        .catch(() => {});
    }
    void readSeeded(seed, '/api/model-settings', () => mediaRequest('/model-settings'))
      .then((value) => {
        if (active) setModels(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
    // startProjects is the page's starting choice; a new array each render must not reset it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, chosenId, ask, seed, start, startProjects?.join('\n')]);
  async function perform(action: () => Promise<void>) {
    setPending(true);
    setError('');
    try {
      await action();
    } catch (failure: any) {
      setError(failure.message);
    } finally {
      setPending(false);
    }
  }
  async function takeScreenshots() {
    await perform(async () => {
      await mediaRequest(`/tasks/${encodeURIComponent(context.taskId!)}/screenshots`, 'POST', {
        target:
          target === 'web' ? { kind: target, url: address } : { kind: target, device: address },
        widths: [390, 1440],
        text: text.trim() || undefined,
      });
      setMenu(null);
      setText('');
      window.dispatchEvent(new Event('deploy:conversation-changed'));
    });
  }
  async function send() {
    if (busy || !text.trim()) return;
    if (
      context.taskId &&
      !attachments.length &&
      /^(show me what it looks like|(?:take|show me) (?:a |some )?screenshots?)/i.test(text.trim())
    ) {
      if (address.trim()) await takeScreenshots();
      else setMenu('screenshot');
      return;
    }
    await perform(async () => {
      const message = {
        text: text.trim(),
        attachments,
        model: override,
        ...(effort ? { effort } : {}),
      };
      if (starting) {
        // One task per chosen project, each on a free computer among the chosen ones.
        const chosen =
          context.chosen && projectIds.length === 1 && projectIds[0] === context.chosen.id;
        const result = await submitMessage(
          {
            ...message,
            ...(projectIds.length ? { projectIds } : {}),
            ...(workerIds.length ? { workerIds } : {}),
          },
          undefined,
          undefined,
          chosen ? context.chosen!.id : undefined,
          // A pull request's Start a task on this branch chose one of the project's branches.
          chosen ? branchRef(location.search) : undefined,
        );
        window.location.assign(`/dashboard/tasks/${encodeURIComponent(result.taskId)}`);
        return;
      }
      if (context.taskId || context.agentId || context.home) {
        const result = await submitMessage(
          message,
          context.taskId,
          context.agentId,
          context.home ? context.chosen?.id : undefined,
          // A pull request's Start a task on this branch chose one of the project's branches.
          context.home && context.chosen ? branchRef(location.search) : undefined,
        );
        if (context.home) {
          window.location.assign(`/dashboard/tasks/${encodeURIComponent(result.taskId)}`);
          return;
        }
        window.dispatchEvent(new Event('deploy:conversation-changed'));
      } else await onSend?.(message.text, message);
      setText('');
      setAttachments([]);
    });
  }
  function pick(accept: string, camera = false) {
    if (!picker.current) return;
    picker.current.accept = accept;
    if (camera) picker.current.setAttribute('capture', 'environment');
    else picker.current.removeAttribute('capture');
    setMenu(null);
    picker.current.click();
  }
  async function projectFiles(path: string) {
    const value = await mediaRequest(
      `/conversation-attachments/projects/${encodeURIComponent(context.projectId!)}?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(projectRef)}`,
    );
    setFiles(value.entries);
    setProjectPath(path);
    setProjectRef(value.commit);
  }
  const selectedModel = models?.choices.find((choice) => choice.id === override);
  const defaultId = models?.defaults[context.agentId ? 'answering-questions' : 'writing-code'];
  const defaultModel = models?.choices.find((choice) => choice.id === defaultId);
  const groups = modelGroups(models, override);
  const efforts = (selectedModel ?? defaultModel)?.efforts ?? [];
  function chooseModel(choice: ModelChoice | null) {
    setOverride(choice?.id ?? null);
    const next = choice ?? defaultModel;
    if (effort && !next?.efforts?.includes(effort)) setEffort('');
    closeMenu();
  }
  // Known from the address, so the chips are there from the first paint on the home page.
  const starting =
    start || location.pathname === '/dashboard' || location.pathname === '/dashboard/';
  const takers = computerList.filter(
    (item) => item.online && item.roles.includes('take-tasks') && item.workerIds[0],
  );
  const query = projectQuery.trim().toLowerCase();
  const shownProjects = projectList.filter((item) => item.name.toLowerCase().includes(query));
  const projectNames = projectIds.map(
    (projectId) =>
      projectList.find((item) => item.id === projectId)?.name ??
      (projectId === context.chosen?.id ? context.chosen.name : (project ?? projectId)),
  );
  const computerNames = workerIds.map(
    (workerId) => takers.find((item) => item.workerIds[0] === workerId)?.name ?? workerId,
  );
  function toggle(list: string[], value: string) {
    return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  }
  return (
    <>
      <form
        className="dl-composer"
        aria-busy={busy || undefined}
        data-disabled={disabled || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {!!attachments.length && (
          <div className="dl-composer-files">
            {attachments.map((attachment) => (
              <span className="dl-chip" key={attachment.ref}>
                <Icon name={attachment.kind === 'file' ? 'file' : 'file'} size={14} />
                <span>
                  {attachment.name}
                  <small>{(attachment.bytes / 1024).toFixed(0)} KiB</small>
                </span>
                <button
                  type="button"
                  className="dl-icon-btn sm"
                  aria-label={`Remove ${attachment.name}`}
                  disabled={busy}
                  onClick={() =>
                    setAttachments((items) => items.filter((item) => item.ref !== attachment.ref))
                  }
                >
                  <Icon name="close" size={14} />
                </button>
              </span>
            ))}
          </div>
        )}
        {typeof mentionQuery === 'string' && (
          <div
            className="dl-agent-mentions"
            role="listbox"
            aria-label="Bring an agent into this task"
          >
            <p className="dl-meta">Bring an agent into this task</p>
            {matches.map((agent, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === mentionIndex}
                key={agent.id}
                className="dl-item"
                onClick={() => chooseMention(agent)}
              >
                <AgentAvatar id={agent.id} avatar={agent.avatar} />
                <span className="dl-t">
                  <span className="dl-agent-name">{agent.name}</span>
                  <span>{agent.lastMessage?.text || 'Say hello'}</span>
                </span>
                {agent.lastMessage && (
                  <span className="dl-meta">{formatTime(agent.lastMessage.at, 'list')}</span>
                )}
              </button>
            ))}
            {!matches.length && (
              <p className="dl-meta">
                {agents.length ? (
                  'No matching agents'
                ) : (
                  <a href="/dashboard/agents/new">New agent</a>
                )}
              </p>
            )}
            <p className="dl-meta">Select a name, then send your message.</p>
          </div>
        )}
        <label htmlFor={id} className="dl-sr">
          Message
        </label>
        <input
          id={id}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setMentionClosed(false);
            setMentionIndex(0);
          }}
          onKeyDown={(event) => {
            if (typeof mentionQuery !== 'string') return;
            if (event.key === 'Escape') {
              event.preventDefault();
              setMentionClosed(true);
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setMentionIndex((i) =>
                Math.max(0, Math.min(matches.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1))),
              );
            } else if (event.key === 'Enter' && matches[mentionIndex]) {
              event.preventDefault();
              chooseMention(matches[mentionIndex]);
            }
          }}
          disabled={busy}
          placeholder="Ask, build, or follow up…"
        />
        <div className="dl-composer-bar">
          <IconButton
            icon="plus"
            label="Attach"
            className="sm"
            disabled={busy}
            onClick={() => {
              if (onAttach) onAttach();
              else setMenu('attach');
            }}
          />
          {starting ? (
            <>
              <button
                ref={projectChip}
                type="button"
                className="dl-chip"
                aria-haspopup="menu"
                aria-expanded={menu === 'projects'}
                aria-label={`Projects: ${chipLabel(projectNames, 'No project', 'projects')}`}
                disabled={busy}
                onClick={() => toggleMenu('projects')}
              >
                <Icon name="folder" size={14} />
                {chipLabel(projectNames, 'No project', 'projects')}
                <Icon name="down" size={12} className="dl-chip-caret" />
              </button>
              <button
                ref={computerChip}
                type="button"
                className="dl-chip"
                aria-haspopup="menu"
                aria-expanded={menu === 'computers'}
                aria-label={`Computers: ${chipLabel(computerNames, 'Any free computer', 'computers')}`}
                disabled={busy}
                onClick={() => toggleMenu('computers')}
              >
                <Icon name="computer" size={14} />
                {chipLabel(computerNames, 'Any free computer', 'computers')}
                <Icon name="down" size={12} className="dl-chip-caret" />
              </button>
            </>
          ) : (
            <>
              {project && (
                <span className="dl-chip">
                  <Icon name="folder" size={14} />
                  {project}
                </span>
              )}
              {computer && (
                <span className="dl-chip">
                  <Icon name="computer" size={14} />
                  {computer}
                </span>
              )}
            </>
          )}
          <span className="dl-grow" />
          <button
            ref={modelButton}
            type="button"
            className="dl-model"
            aria-haspopup={onModel ? undefined : 'menu'}
            aria-expanded={onModel ? undefined : menu === 'model'}
            onClick={() => {
              if (onModel) onModel();
              else toggleMenu('model');
            }}
            disabled={busy}
            aria-label={`Model for this chat: ${selectedModel?.name || defaultModel?.name || (onModel ? model : 'Auto')}`}
          >
            {selectedModel?.name || defaultModel?.name || (onModel ? model : 'Auto')}
            <Icon name="down" size={12} />
          </button>
          <IconButton
            icon="voice"
            label="Voice"
            className="sm"
            disabled={busy || !onVoice}
            onClick={onVoice}
          />
          <button
            className="dl-send"
            type="submit"
            aria-label={pending ? 'Sending' : 'Send'}
            disabled={busy || !text.trim()}
          >
            <Icon name={pending ? 'running' : 'send'} className={pending ? 'dl-spin' : ''} />
          </button>
        </div>
        {error && (
          <p className="dl-field-error" role="alert">
            {error}
          </p>
        )}
        {footer}
      </form>
      <input
        type="file"
        multiple
        hidden
        ref={picker}
        onChange={(event) => {
          const selected = Array.from(event.target.files || []);
          event.target.value = '';
          void perform(async () => {
            if (attachments.length + selected.length > 8)
              throw new Error('At most eight attachments are allowed');
            for (const file of selected) {
              const attachment = await uploadFile(file, file.name);
              setAttachments((items) => [...items, attachment]);
            }
          });
        }}
      />
      <Dialog open={menu === 'attach'} onClose={() => setMenu(null)} title="Attach">
        <div className="dl-media-options">
          <button
            type="button"
            className="dl-item"
            onClick={() => pick('image/png,image/jpeg,image/webp,image/gif')}
          >
            <Icon name="file" />
            Photos
          </button>
          <button type="button" className="dl-item" onClick={() => pick('image/*', true)}>
            <Icon name="file" />
            Take a photo
          </button>
          <button
            type="button"
            className="dl-item"
            onClick={() =>
              pick('.txt,.md,.csv,.json,.pdf,.zip,.xlsx,.docx,.png,.jpg,.jpeg,.gif,.webp')
            }
          >
            <Icon name="file" />
            Files
          </button>
          <button
            type="button"
            className="dl-item"
            disabled={!context.taskId}
            onClick={() => setMenu('screenshot')}
          >
            <Icon name="file" />A screenshot of the app
          </button>
          <button
            type="button"
            className="dl-item"
            disabled={!context.projectId}
            onClick={() => {
              setMenu('project');
              void perform(() => projectFiles(''));
            }}
          >
            <Icon name="folder" />A file from {project}
          </button>
        </div>
        <p className="dl-meta">
          Only the files you pick are shared. Up to 10 MiB each. Screenshots and project files are
          available within a task.
        </p>
      </Dialog>
      <PopoverMenu
        anchor={modelButton}
        open={menu === 'model'}
        onClose={() => dismiss('model')}
        onHoverRow={closeSubmenu}
        placement="end"
        label="Model for this chat"
      >
        <MenuRow checked={!override} hint={defaultModel?.name} onSelect={() => chooseModel(null)}>
          Auto
        </MenuRow>
        {groups.main.map((choice) => (
          <MenuRow
            key={choice.id}
            checked={override === choice.id}
            onSelect={() => chooseModel(choice)}
          >
            {choice.name}
          </MenuRow>
        ))}
        <MenuSeparator />
        <SubMenu
          label="Effort"
          end={effortLabel(effort)}
          open={submenu === 'effort'}
          disabled={!efforts.length}
          onOpen={() => setSubmenu('effort')}
          onClose={closeSubmenu}
        >
          {['', ...efforts].map((level) => (
            <MenuRow
              key={level || 'default'}
              checked={effort === level}
              onSelect={() => {
                setEffort(level);
                closeMenu();
              }}
            >
              {effortLabel(level)}
            </MenuRow>
          ))}
        </SubMenu>
        {!!groups.more.length && (
          <SubMenu
            label="More models"
            open={submenu === 'more'}
            onOpen={() => setSubmenu('more')}
            onClose={closeSubmenu}
          >
            {groups.more.map((group) => (
              <div key={group.provider} role="group" aria-label={group.name}>
                <span className="dl-menu-label">{group.name}</span>
                {group.choices.map((choice) => (
                  <MenuRow
                    key={choice.id}
                    checked={override === choice.id}
                    onSelect={() => chooseModel(choice)}
                  >
                    {choice.name}
                  </MenuRow>
                ))}
              </div>
            ))}
          </SubMenu>
        )}
        <MenuSeparator />
        <span className="dl-menu-note">
          {models ? 'Only this chat. ' : 'Models are unavailable. '}
          <a href="/dashboard/computers/models">Change defaults</a>
        </span>
      </PopoverMenu>
      <PopoverMenu
        anchor={projectChip}
        open={menu === 'projects'}
        onClose={() => {
          dismiss('projects');
          setProjectQuery('');
        }}
        label="Projects"
      >
        <label className="dl-field dl-menu-search">
          <Icon name="search" size={14} />
          <input
            type="search"
            value={projectQuery}
            placeholder="Search projects"
            aria-label="Search projects"
            onChange={(event) => setProjectQuery(event.target.value)}
          />
        </label>
        {shownProjects.map((item) => (
          <MenuRow
            key={item.id}
            kind="checkbox"
            checked={projectIds.includes(item.id)}
            onSelect={() => setProjectIds((ids) => toggle(ids, item.id))}
          >
            {item.name}
          </MenuRow>
        ))}
        {query && !shownProjects.length && (
          <span className="dl-menu-note">No matching projects</span>
        )}
        <MenuSeparator />
        <MenuRow
          kind="checkbox"
          checked={!projectIds.length}
          hint="Starts in an empty folder"
          onSelect={() => setProjectIds([])}
        >
          No project
        </MenuRow>
        <span className="dl-menu-note">Pick several to work across them</span>
      </PopoverMenu>
      <PopoverMenu
        anchor={computerChip}
        open={menu === 'computers'}
        onClose={() => dismiss('computers')}
        label="Computers"
      >
        <span className="dl-menu-label">Computers</span>
        <MenuRow
          kind="checkbox"
          checked={!workerIds.length}
          hint="deploy.local chooses"
          onSelect={() => setWorkerIds([])}
        >
          Any free computer
        </MenuRow>
        <MenuSeparator />
        {takers.map((item) => {
          const tasks = item.doing.filter((thing) => thing.kind === 'task').length;
          return (
            <MenuRow
              key={item.id}
              kind="checkbox"
              checked={workerIds.includes(item.workerIds[0])}
              end={tasks ? `${tasks} task${tasks === 1 ? '' : 's'}` : 'Free'}
              onSelect={() => setWorkerIds((ids) => toggle(ids, item.workerIds[0]))}
            >
              {item.name}
            </MenuRow>
          );
        })}
        <span className="dl-menu-note">
          {takers.length
            ? 'Pick several to work across them'
            : 'No computer that takes tasks is online'}
        </span>
      </PopoverMenu>
      <Dialog
        open={menu === 'screenshot'}
        onClose={() => {
          if (!pending) setMenu(null);
        }}
        title="A screenshot of the app"
        loading={pending}
        actions={
          <button
            type="button"
            className="dl-btn primary"
            disabled={pending || !address.trim()}
            onClick={() => void takeScreenshots()}
          >
            Take screenshots
          </button>
        }
      >
        <label className="dl-media-field">
          App type
          <select value={target} onChange={(event) => setTarget(event.target.value)}>
            <option value="web">Web app · phone and laptop</option>
            <option value="ios-simulator">iOS simulator</option>
            <option value="desktop">Desktop window</option>
          </select>
        </label>
        <label className="dl-media-field">
          {target === 'web'
            ? 'App address on its computer'
            : target === 'ios-simulator'
              ? 'Simulator UUID'
              : 'Approved window ID'}
          <input value={address} onChange={(event) => setAddress(event.target.value)} />
        </label>
        <p className="dl-meta">
          Taken on the task’s computer. Desktop windows require Use the screen permission.
        </p>
        {error && (
          <p role="alert" className="dl-field-error">
            {error}
          </p>
        )}
      </Dialog>
      <Dialog
        open={menu === 'project'}
        onClose={() => setMenu(null)}
        title={`A file from ${project}`}
      >
        <p className="dl-meta">{projectPath || '/'} · saved project version</p>
        {projectPath && (
          <button
            type="button"
            className="dl-btn secondary"
            onClick={() =>
              void perform(() => projectFiles(projectPath.split('/').slice(0, -1).join('/')))
            }
          >
            Back
          </button>
        )}
        <div className="dl-media-options">
          {files.map((file) => (
            <button
              type="button"
              className="dl-item"
              key={file.path}
              disabled={pending || attachments.length >= 8}
              onClick={() =>
                void perform(async () => {
                  if (file.type === 'tree') await projectFiles(file.path);
                  else {
                    const value = await mediaRequest(
                      `/conversation-attachments/projects/${encodeURIComponent(context.projectId!)}`,
                      'POST',
                      { path: file.path, ref: projectRef },
                    );
                    setAttachments((items) => [...items, value.attachment]);
                    setMenu(null);
                  }
                })
              }
            >
              <Icon name={file.type === 'tree' ? 'folder' : 'file'} />
              {file.name}
            </button>
          ))}
        </div>
        {error && (
          <p role="alert" className="dl-field-error">
            {error}
          </p>
        )}
      </Dialog>
    </>
  );
}
