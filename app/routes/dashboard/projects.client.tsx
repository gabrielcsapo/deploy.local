'use client';
import { Select } from '@/components/ui';
import {
  useEffect,
  useCallback,
  useLayoutEffect,
  useState,
  useRef,
  useMemo,
  type ReactNode,
} from 'react';
import { Link, useRouter, useLocation } from 'react-flight-router/client';
import './workspace.css';
import '../../design-tokens.css';
import '../../native-workspace.css';
import {
  workspaceRequest,
  WorkspaceRequestError,
  workspaceConnectionMessage,
} from './command-journal';
import { TaskActivity, TaskSources } from './task-activity.client';
import { TaskQuestion } from './task-question.client';
import { WorkspaceIcon } from './workspace-icon';
import { VoiceInput } from './voice-input.client';
import { ComposerControls } from './composer-controls.client';
import { SurfaceNavigation, useWorkspaceKeyboard } from './workspace-navigation.client';
import { ProjectHub } from './project-hub.client';
import { ControlPanel } from './control-panel.client';
import { WorkspaceRail } from './workspace-rail.client';
import { SidebarResizeHandle, useSidebarResize } from './workspace-resize.client';
import { MessageContent } from './message-content.client';
import { indexTranscript } from './transcript-index';
import { TaskResource } from './task-resource';
import { useWorkspacePerformance } from './workspace-performance';
import { LoginForm } from './data.client';
import { getAuth } from './detail/shared';
type Row = Record<string, any>;
export default function ProjectsClient({ surface }: { surface?: ReactNode } = {}) {
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => {
    setAuthed(Boolean(getAuth()));
  }, []);
  if (authed === null)
    return (
      <div className="ds-feedback" role="status">
        Connecting to workspace…
      </div>
    );
  if (!authed) return <LoginForm onLogin={() => setAuthed(true)} />;
  return <ProjectWorkspace surface={surface} />;
}
function ProjectWorkspace({ surface }: { surface?: ReactNode }) {
  const { navigate } = useRouter();
  const { pathname } = useLocation();
  const repositoryView = pathname === '/dashboard/repositories';
  useWorkspaceKeyboard();
  const sidebarResize = useSidebarResize();
  const surfaceTitle = pathname.startsWith('/dashboard/design-system')
    ? 'Design system'
    : pathname.startsWith('/dashboard/settings')
      ? 'Settings'
      : pathname.startsWith('/dashboard/nodes')
        ? 'Computers'
        : pathname.startsWith('/dashboard/catalog')
          ? 'Catalog'
          : pathname.startsWith('/dashboard/discover')
            ? 'Shared apps'
            : pathname.startsWith('/dashboard/logs')
              ? 'Logs'
              : pathname.startsWith('/dashboard/activity')
                ? 'Activity'
                : 'Applications';
  function returnToChat() {
    if (surface || repositoryView) void navigate('/dashboard');
  }
  const [needsAuthentication, setNeedsAuthentication] = useState(false);
  // In-flight refreshes must see expiry immediately, before React restarts the event listener.
  const authenticationRequired = useRef(false);
  authenticationRequired.current = needsAuthentication;
  const [signingIn, setSigningIn] = useState(false);
  const account = useRef(getAuth()?.username);
  const [state, setState] = useState<Row>({ projects: [], tasks: [], workers: [], adapters: [] }),
    [selected, setSelected] = useState(() =>
      typeof window !== 'undefined' ? localStorage.getItem('workspace-selected-task') || '' : '',
    ),
    [project, setProject] = useState(''),
    [workerId, setWorkerId] = useState('local'),
    [model, setModel] = useState(''),
    [effort, setEffort] = useState(''),
    [adapter, setAdapter] = useState('codex'),
    [detail, setDetail] = useState<Row | null>(null),
    [patch, setPatch] = useState<Row | null>(null),
    [patchError, setPatchError] = useState(''),
    [draft, setDraft] = useState(''),
    [name, setName] = useState(''),
    [source, setSource] = useState(''),
    [search, setSearch] = useState(''),
    [creatingProject, setCreatingProject] = useState(false),
    [error, setError] = useState(''),
    [connectionError, setConnectionError] = useState(''),
    [busy, setBusy] = useState(false),
    [panel, setPanel] = useState('changes'),
    [inspector, setInspector] = useState(false),
    [controlVisible, setControlVisible] = useState(false),
    [sidebar, setSidebar] = useState(false),
    [checkCommand, setCheckCommand] = useState('');
  useEffect(() => {
    const toggle = () => setSidebar((open) => !open);
    const resize = () => {
      if (!matchMedia('(max-width:760px)').matches) setSidebar(false);
    };
    window.addEventListener('resize', resize);
    window.addEventListener('deploy:toggle-navigation', toggle);
    return () => {
      window.removeEventListener('deploy:toggle-navigation', toggle);
      window.removeEventListener('resize', resize);
    };
  }, []);
  const drawerWasOpen = useRef(false);
  useLayoutEffect(() => {
    if (!sidebar && drawerWasOpen.current) {
      drawerWasOpen.current = false;
      [...document.querySelectorAll<HTMLElement>('.pw-mobile-menu')]
        .find((el) => el.getClientRects().length)
        ?.focus();
    }
    const root = document.querySelector('.project-workspace');
    const compact = matchMedia('(max-width:760px)').matches;
    const aside = [...(root?.querySelectorAll<HTMLElement>(':scope>.pw-sidebar') || [])].find(
      (el) => el.getClientRects().length > 0,
    );
    if (!aside) return;
    const work = root?.querySelectorAll<HTMLElement>(
      ':scope>.pw-chat,:scope>.pw-surface,:scope>.pw-context,:scope>.ds-task-list,:scope>.workspace-rail',
    );
    if (sidebar && compact) {
      drawerWasOpen.current = true;
      aside.setAttribute('role', 'dialog');
      aside.setAttribute('aria-modal', 'true');
      work?.forEach((el) => (el.inert = true));
      aside.querySelector<HTMLElement>('button,a,select')?.focus();
    }
    return () => {
      aside.removeAttribute('role');
      aside.removeAttribute('aria-modal');
      work?.forEach((el) => (el.inert = false));
    };
  }, [sidebar, pathname]);
  useEffect(() => setSidebar(false), [pathname]);
  const [projectHub, setProjectHub] = useState<Row | null>(null);
  useEffect(() => {
    if (repositoryView && !projectHub && state.projects.length) setProjectHub(state.projects[0]);
  }, [repositoryView, projectHub, state.projects]);
  const [taskSection, setTaskSection] = useState('conversation');
  const timing = useWorkspacePerformance(detail, selected);
  const timingRef = useRef(timing);
  timingRef.current = timing;
  const transcriptIndex = useMemo(
    () => indexTranscript(detail?.messages ?? [], detail?.activity ?? []),
    [detail?.messages, detail?.activity],
  );
  const readingPositions = useRef(new Map<string, { top: number; start: number; end: number }>());
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followTranscript = useRef(true);

  const composerRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const saved = readingPositions.current.get(selected);
    followTranscript.current = !saved;
    const positions = readingPositions.current,
      transcript = transcriptRef.current,
      editor = composerRef.current;
    return () => {
      positions.set(selected, {
        top: transcript?.scrollTop || 0,
        start: editor?.selectionStart || 0,
        end: editor?.selectionEnd || 0,
      });
    };
  }, [selected]);
  useLayoutEffect(() => {
    const saved = readingPositions.current.get(selected);
    if (saved && detail?.task.id === selected) {
      if (transcriptRef.current) transcriptRef.current.scrollTop = saved.top;
      composerRef.current?.setSelectionRange(saved.start, saved.end);
    }
  }, [selected, detail?.task.id]);
  const projectDialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const input = composerRef.current;
    if (input) {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 180) + 'px';
    }
  }, [draft]);
  const selectedRef = useRef(selected);
  const eventCursor = useRef(0);
  const refreshGeneration = useRef(0);
  const loadedSettings = useRef('');
  const lastMessageContent = detail?.messages?.at(-1)?.content;
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript && followTranscript.current) transcript.scrollTop = transcript.scrollHeight;
  }, [selected, detail?.messages?.length, lastMessageContent]);
  selectedRef.current = selected;
  useEffect(() => {
    const openProject = (event: Event) => {
      const requestedProject = (event as CustomEvent<Row>).detail;
      if (requestedProject?.id && requestedProject?.name) {
        setProjectHub(requestedProject);
        void navigate('/dashboard/repositories');
      }
    };
    window.addEventListener('deploy:open-project', openProject);
    return () => window.removeEventListener('deploy:open-project', openProject);
  }, [navigate]);
  useEffect(() => {
    if (selected) localStorage.setItem('workspace-selected-task', selected);
    else localStorage.removeItem('workspace-selected-task');
  }, [selected]);
  const api = useCallback(async (path: string, body?: Row, signal?: AbortSignal) => {
    if (authenticationRequired.current)
      throw new WorkspaceRequestError(401, 'Sign in again to continue.');
    try {
      return await workspaceRequest(path, body, getAuth(), localStorage, fetch, signal);
    } catch (failure) {
      if (!signal?.aborted && failure instanceof WorkspaceRequestError && failure.status === 401) {
        authenticationRequired.current = true;
        setNeedsAuthentication(true);
        setConnectionError(workspaceConnectionMessage(failure));
      }
      throw failure;
    }
  }, []);
  const patchResource = useRef<TaskResource<Row> | null>(null);
  if (!patchResource.current) {
    patchResource.current = new TaskResource<Row>(
      (taskId, signal) => api('/tasks/' + taskId + '/diff', undefined, signal),
      (value) => {
        setPatch(value);
        setPatchError('');
      },
      () =>
        setPatchError(
          'Changes could not be refreshed. Retrying; the conversation is still available.',
        ),
    );
  }
  useEffect(() => {
    const resource = patchResource.current;
    if (needsAuthentication) resource?.cancel();
    return () => resource?.cancel();
  }, [selected, needsAuthentication]);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const generation = ++refreshGeneration.current;
      try {
        const next = await api('/state', undefined, signal);
        if (signal?.aborted || generation !== refreshGeneration.current) return;
        eventCursor.current = next.cursor;
        setState(next);
        const taskId = selectedRef.current;
        if (taskId) {
          const nextDetail = await api('/tasks/' + taskId, undefined, signal);
          if (signal?.aborted || generation !== refreshGeneration.current) return;
          if (selectedRef.current === taskId) {
            if (loadedSettings.current !== taskId) {
              const last = nextDetail.runs?.at(-1);
              if (last) {
                setAdapter(last.adapter);
                setModel(last.model || '');
                setEffort(last.effort || '');
              }
              setProject(nextDetail.task.projectId || '');
              loadedSettings.current = taskId;
            }
            timingRef.current.applying(taskId, nextDetail);
            setDetail(nextDetail);
            // Diff IO has its own bounded queue; it must not delay the next event read.
            patchResource.current?.request(taskId);
          }
        }
        setConnectionError('');
      } catch (failure) {
        if (signal?.aborted || generation !== refreshGeneration.current) return;
        setConnectionError(workspaceConnectionMessage(failure));
        throw failure;
      }
    },
    [api],
  );
  useEffect(() => {
    if (needsAuthentication) return;
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const pause = () =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(retryTimer);
          controller.signal.removeEventListener('abort', done);
          resolve();
        };
        retryTimer = setTimeout(done, 1000);
        controller.signal.addEventListener('abort', done, { once: true });
      });
    async function listen() {
      while (!controller.signal.aborted) {
        try {
          await refresh(controller.signal);
          const page = await api(
            '/events?after=' + eventCursor.current + '&waitMs=10000',
            undefined,
            controller.signal,
          );
          if (
            page.events?.some(
              (event: Row) => event.taskId === selectedRef.current && event.type === 'message',
            )
          )
            timingRef.current.received(selectedRef.current);
          if (!page.supportsWait && !controller.signal.aborted) await pause();
        } catch (failure) {
          if (controller.signal.aborted) return;
          setConnectionError(workspaceConnectionMessage(failure));
          if (failure instanceof WorkspaceRequestError && failure.status === 401) return;
          await pause();
        }
      }
    }
    void listen();
    return () => {
      controller.abort();
      clearTimeout(retryTimer);
    };
  }, [needsAuthentication, api, refresh]);
  useEffect(() => {
    setDetail(null);
    setPatch(null);
    setPatchError('');
    setDraft(localStorage.getItem('workspace-draft-' + (selected || 'new')) || '');
    if (selected) void refresh().catch(() => {});
  }, [selected, refresh]);
  async function action(fn: () => Promise<void>) {
    setError('');
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const selectedProject = state.projects.find((p: Row) => p.id === detail?.task.projectId);
  const fileCount = patch?.files?.length || 0;
  const waitingForAnswer = detail?.questions?.some((q: Row) => q.status === 'pending');
  const statusLabel = waitingForAnswer
    ? 'Waiting for your answer'
    : (
        {
          review: 'Ready to review',
          ready: 'Ready',
          running: 'Working',
          checking: 'Running checks',
          queued: 'Queued',
          stopped: 'Stopped',
          failed: 'Needs attention',
        } as Record<string, string>
      )[detail?.task.status] || detail?.task.status;
  const active =
    detail?.task.status === 'checking' ||
    detail?.runs?.some((r: Row) => ['queued', 'starting', 'running'].includes(r.status));
  const worker = state.workers.find((w: Row) => w.id === (detail?.task.workerId || workerId));
  useEffect(() => {
    if (
      !selected &&
      !state.workers.some((w: Row) => w.id === workerId) &&
      state.workers.some((w: Row) => w.status === 'online')
    )
      setWorkerId(state.workers.find((w: Row) => w.status === 'online')!.id);
  }, [state.workers, selected, workerId]);
  const options = worker?.modelOptions?.find((a: Row) => a.id === adapter);
  const models: Row[] = options?.models || [];
  const efforts: string[] = useMemo(() => {
    const choice = worker?.modelOptions?.find((a: Row) => a.id === adapter);
    return choice?.models?.find((m: Row) => m.id === model)?.efforts ?? choice?.efforts ?? [];
  }, [worker, adapter, model]);
  useEffect(() => {
    setEffort((prior) => (efforts.includes(prior) ? prior : ''));
  }, [efforts]);
  const chooseAdapter = (value: string) => {
    setAdapter(value);
    setModel('');
    setEffort('');
  };
  const chooseModel = (value: string) => {
    setModel(value);
    setEffort('');
  };
  const canSend = Boolean(
    draft.trim() &&
    !needsAuthentication &&
    !active &&
    !busy &&
    worker?.status === 'online' &&
    (worker.id === 'local' || worker.capabilities?.includes(adapter)) &&
    (!selected || detail),
  );
  const matches = (task: Row) => task.title.toLowerCase().includes(search.toLowerCase());
  const tasks = [...state.tasks].sort((a: Row, b: Row) =>
    String(b.updatedAt).localeCompare(String(a.updatedAt)),
  );
  function newTask(projectId = '') {
    returnToChat();
    setTaskSection('conversation');
    setSelected('');
    loadedSettings.current = '';
    selectedRef.current = '';
    setDetail(null);
    setPatch(null);
    setProject(projectId);
    setInspector(false);
    setSidebar(false);
    setDraft(localStorage.getItem('workspace-draft-new') || '');
    requestAnimationFrame(() => composerRef.current?.focus());
  }
  async function send() {
    if (!canSend) return;
    await action(async () => {
      let task = detail?.task;
      if (!task) {
        task = await api('/tasks', {
          projectId: project || undefined,
          title: draft.trim().split('\n')[0].slice(0, 72),
          workerId,
        });
        localStorage.setItem('workspace-draft-' + task.id, draft);
        selectedRef.current = task.id;
        setSelected(task.id);
        setDetail({ task, messages: [], runs: [], events: [] });
      }
      await api('/tasks/' + task.id + '/messages', {
        revision: task.revision,
        content: draft.trim(),
        model: model || undefined,
        effort: effort || undefined,
        adapter,
      });
      setDraft('');
      localStorage.removeItem('workspace-draft-' + (selected || 'new'));
      localStorage.removeItem('workspace-draft-' + task.id);
      if (composerRef.current) composerRef.current.style.height = 'auto';
    });
  }
  function taskRow(task: Row, nested = false) {
    return (
      <button
        className={`pw-task ${nested ? 'is-nested' : ''}`}
        aria-current={selected === task.id ? 'page' : undefined}
        key={task.id}
        title={`${task.title} — ${taskStatus(task.status)}`}
        onClick={() => {
          returnToChat();
          setTaskSection('conversation');
          setInspector(false);
          setSelected(task.id);
          setSidebar(false);
        }}
      >
        <span className="pw-task-name">{task.title}</span>
        {['running', 'checking', 'queued', 'failed'].includes(task.status) && (
          <span
            className={`pw-dot ${task.status}`}
            role="img"
            aria-label={taskStatus(task.status)}
          />
        )}
      </button>
    );
  }
  useEffect(() => {
    const dialog = projectDialogRef.current;
    if (creatingProject && dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector('input')?.focus();
    } else if (!creatingProject && dialog?.open) dialog.close();
  }, [creatingProject]);
  if (signingIn)
    return (
      <LoginForm
        onLogin={() => {
          if (getAuth()?.username !== account.current) {
            window.location.reload();
            return;
          }
          setSigningIn(false);
          setNeedsAuthentication(false);
          setConnectionError('');
          setError('');
        }}
      />
    );
  return (
    <div
      style={sidebarResize.style}
      className={`project-workspace ${!selected ? 'is-composing' : ''} ${inspector && !surface && !repositoryView && taskSection !== 'tasks' ? 'has-inspector' : ''} ${sidebar ? 'show-sidebar' : ''} ${surface ? 'has-surface' : ''} ${repositoryView ? 'has-repository' : ''} ${!surface && !repositoryView && taskSection === 'tasks' ? 'has-task-list' : ''}`}
    >
      {timing.enabled && <output hidden ref={timing.output} data-workspace-performance="true" />}
      <WorkspaceRail workers={state.workers} workerId={worker?.id} />
      <SidebarResizeHandle width={sidebarResize.width} update={sidebarResize.update} />
      {sidebar && (
        <button
          className="pw-sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside className="pw-sidebar" aria-label="Workspace navigation">
        <header className="ds-context-heading">
          <strong>Tasks</strong>
          <button
            className="pw-icon-button"
            aria-label="Create project"
            onClick={() => setCreatingProject(true)}
          >
            <WorkspaceIcon name="plus" />
          </button>
        </header>
        <label className="ds-context-picker">
          <span>Project</span>
          <Select
            aria-label="Task project"
            value={project}
            onChange={(e) => {
              setProject(e.target.value);
              if (selected) setTaskSection('tasks');
              setInspector(false);
            }}
          >
            <option value="">{taskSection === 'tasks' ? 'All projects' : 'No project'}</option>
            {state.projects.map((p: Row) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </label>
        <nav className="ds-context-links" aria-label="Task sections">
          <button
            aria-current={taskSection === 'tasks' ? 'page' : undefined}
            onClick={() => {
              setTaskSection('tasks');
              setInspector(false);
              setSidebar(false);
            }}
          >
            All tasks
          </button>
          <button
            aria-current={taskSection !== 'tasks' && !inspector ? 'page' : undefined}
            onClick={() => {
              setTaskSection('conversation');
              setInspector(false);
              setSidebar(false);
            }}
          >
            Conversation
          </button>
          {selected && (
            <button
              aria-current={inspector ? 'page' : undefined}
              onClick={() => {
                setTaskSection('conversation');
                setInspector(true);
                setPanel('changes');
                setSidebar(false);
              }}
            >
              Code review
            </button>
          )}
        </nav>
      </aside>
      {surface && <SurfaceNavigation pathname={pathname} />}
      {!surface && !repositoryView && taskSection === 'tasks' && (
        <section className="ds-task-list ds-work-pane" aria-label="Tasks">
          <header className="ds-pane-toolbar">
            <button
              className="pw-mobile-menu"
              aria-label="Show sidebar"
              onClick={() => setSidebar(!sidebar)}
            >
              <WorkspaceIcon name="sidebar" />
            </button>
            <label className="ds-input-shell" data-appearance="plain">
              <WorkspaceIcon name="search" />
              <input
                aria-label="Filter tasks"
                placeholder="Filter tasks…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <button onClick={() => newTask(project)}>New task</button>
          </header>
          <div className="ds-table-scroll" tabIndex={0} aria-label="Task list">
            <table className="ds-resource-table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Status</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {tasks
                  .filter((t: Row) => (!project || t.projectId === project) && matches(t))
                  .map((t: Row) => (
                    <tr key={t.id} data-selected={selected === t.id || undefined}>
                      <td>{taskRow(t)}</td>
                      <td>{taskStatus(t.status)}</td>
                      <td>{t.updatedAt ? new Date(t.updatedAt).toLocaleString() : '—'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {!tasks.some((t: Row) => (!project || t.projectId === project) && matches(t)) && (
              <p className="ds-feedback" role="status">
                {search ? 'No matching tasks' : 'No tasks yet'}
                {search && <button onClick={() => setSearch('')}>Clear search</button>}
              </p>
            )}
          </div>
        </section>
      )}
      <section className="pw-chat" aria-label="Conversation">
        <header className="pw-header">
          <button
            className="pw-mobile-menu"
            aria-label="Toggle navigation"
            aria-expanded={sidebar}
            onClick={() => setSidebar(!sidebar)}
          >
            <WorkspaceIcon name="sidebar" />
          </button>
          <div className="pw-heading">
            <strong title={detail?.task.title}>
              {detail?.task.title || (selected ? 'Loading task…' : 'New task')}
            </strong>
            {detail && selectedProject && (
              <span className="pw-header-project">
                <WorkspaceIcon name={selectedProject ? 'folder' : 'chat'} />
                {selectedProject?.name || 'No project'}
              </span>
            )}
          </div>
          {detail && (
            <>
              <div className="pw-conversation-context">
                <span
                  className="pw-conversation-computer"
                  title={worker?.name || detail.task.workerId}
                >
                  <WorkspaceIcon name="computer" />
                  <span>{worker?.name || detail.task.workerId || 'Unavailable'}</span>
                </span>
                <span className="pw-header-status">
                  <span className={`pw-dot ${detail.task.status}`} />
                  {statusLabel}
                </span>
              </div>
              <button
                className="pw-inspector-toggle"
                aria-label="Open computer use"
                onClick={() => setControlVisible(true)}
              >
                <WorkspaceIcon name="computer" />
              </button>
              <button
                className="pw-inspector-toggle"
                aria-pressed={inspector}
                onClick={() => setInspector(!inspector)}
              >
                <WorkspaceIcon name="sidebar" />
                Changes{fileCount > 0 && <span className="pw-count">{fileCount}</span>}
              </button>
            </>
          )}
        </header>
        {(connectionError || error) && (
          <div className="pw-error" role="alert">
            {connectionError || error}
            {needsAuthentication && (
              <button onClick={() => setSigningIn(true)}>Sign in again</button>
            )}
          </div>
        )}
        <div
          className="pw-transcript"
          ref={transcriptRef}
          onScroll={(event) => {
            const target = event.currentTarget;
            followTranscript.current =
              target.scrollHeight - target.scrollTop - target.clientHeight < 100;
          }}
        >
          <div className="pw-conversation">
            {!selected && <div className="pw-empty"></div>}
            {detail && !detail.messages.length && <div className="pw-empty"></div>}
            {transcriptIndex.visible.map((m: Row) => (
              <div key={m.id}>
                {m.role === 'assistant' &&
                  transcriptIndex.firstAssistant.get(m.runId) === m.id &&
                  transcriptIndex.activityByRun.has(m.runId) && (
                    <TaskActivity
                      activity={transcriptIndex.activityByRun.get(m.runId)!}
                      progress={transcriptIndex.progress.get(m.runId) ?? []}
                    />
                  )}
                <div
                  className={'pw-message ' + m.role}
                  aria-label={
                    m.role === 'user'
                      ? 'You'
                      : m.adapter === 'claude'
                        ? 'Claude'
                        : m.adapter === 'compatible'
                          ? 'Local model'
                          : 'Codex'
                  }
                >
                  <MessageContent content={m.content} />
                </div>
              </div>
            ))}
            {transcriptIndex.trailingActivity.map((a: Row) => (
              <TaskActivity
                key={a.id}
                activity={a}
                progress={transcriptIndex.progress.get(a.id) ?? []}
              />
            ))}
            {detail && detail.jobs?.length > 0 && (
              <details className="pw-jobs pw-task-sources">
                <summary>
                  <WorkspaceIcon name="terminal" />
                  Processes across computers <span>{detail.jobs.length}</span>
                  <WorkspaceIcon name="chevron-down" />
                </summary>
                {detail.jobs.map((job: Row) => (
                  <details className="pw-job" key={job.id}>
                    <summary>
                      <span>
                        {state.workers.find((w: Row) => w.id === job.workerId)?.name ||
                          job.workerId ||
                          'Waiting for computer'}
                      </span>
                      <span className="pw-muted">
                        {job.stopRequested && job.status === 'running'
                          ? 'Stopping…'
                          : job.status.replaceAll('_', ' ')}
                      </span>
                    </summary>
                    <code>{job.command}</code>
                    <p className="pw-muted">
                      Checkpoint {job.digest.slice(0, 12)}
                      {job.exitCode != null ? ` · Exit ${job.exitCode}` : ''}
                    </p>
                    {job.waitingReason && <p className="pw-muted">{job.waitingReason}</p>}
                    {job.output && <pre>{job.output}</pre>}
                    {job.truncated && (
                      <p className="pw-muted">Showing the last 64,000 characters.</p>
                    )}
                    {job.error && <p role="alert">{job.error}</p>}
                    {['queued', 'running'].includes(job.status) && (
                      <button
                        disabled={busy || job.stopRequested}
                        onClick={() =>
                          void action(async () => {
                            await api(`/tasks/${detail.task.id}/jobs/${job.id}/cancel`, {});
                          })
                        }
                      >
                        {job.stopRequested ? 'Cancellation requested' : 'Cancel job'}
                      </button>
                    )}
                  </details>
                ))}
              </details>
            )}
            {detail?.activity && <TaskSources activity={detail.activity} />}
            {detail?.questions?.some((q: Row) => q.status !== 'pending') && (
              <details className="pw-task-sources">
                <summary>
                  <WorkspaceIcon name="chat" />
                  Questions and answers
                  <WorkspaceIcon name="chevron-down" />
                </summary>
                {detail.questions
                  .filter((q: Row) => q.status !== 'pending')
                  .map((q: Row) => (
                    <div key={q.id}>
                      <p>{q.question}</p>
                      <p className="pw-muted">{q.answer || q.status}</p>
                    </div>
                  ))}
              </details>
            )}
            {active && !waitingForAnswer && (
              <p className="pw-working">
                <span className="pw-dot running" />
                {statusLabel || 'Working'}…
              </p>
            )}
            {detail?.runs
              .slice(-1)
              .filter((r: Row) => r.error)
              .map((r: Row) => (
                <p className="pw-error" key={r.id}>
                  {r.error}
                </p>
              ))}
          </div>
        </div>
        <div
          className={`pw-compose-area ${!selected ? 'is-new-task' : ''} ${detail?.questions?.some((q: Row) => q.status === 'pending') ? 'has-question' : ''}`}
        >
          {detail?.questions
            ?.filter((q: Row) => q.status === 'pending')
            .map((q: Row) => (
              <TaskQuestion
                key={q.id}
                question={q as any}
                disabled={busy || Boolean(connectionError)}
                answer={async (answer, dismiss) => {
                  await api(`/tasks/${q.taskId}/questions/${q.id}/answer`, {
                    answer,
                    dismiss: Boolean(dismiss),
                  });
                  await refresh();
                }}
              />
            ))}
          {detail?.questions?.some((q: Row) => q.status === 'pending') && (
            <button
              className="pw-question-stop"
              disabled={busy || Boolean(connectionError)}
              onClick={() =>
                void action(async () => {
                  await api('/tasks/' + selected + '/stop', { revision: detail!.task.revision });
                })
              }
            >
              <WorkspaceIcon name="stop" />
              Stop task
            </button>
          )}
          {!selected && (
            <div className="pw-new-context">
              <label className="pw-computer-picker">
                <span className="sr-only">Execution computer</span>
                <Select
                  aria-label="Execution computer"
                  value={workerId}
                  onChange={(e) => setWorkerId(e.target.value)}
                >
                  {state.workers.map((w: Row) => (
                    <option key={w.id} value={w.id}>
                      {w.name || w.id}
                      {w.status !== 'online' ? ' (offline)' : ''}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
          )}
          <div className="pw-composer">
            <textarea
              ref={composerRef}
              aria-label="Message"
              data-appearance="plain"
              rows={2}
              disabled={Boolean(selected && !detail)}
              placeholder={selected ? 'Ask, build, or follow up…' : 'Describe a task…'}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                localStorage.setItem('workspace-draft-' + (selected || 'new'), e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="pw-composer-toolbar">
              <VoiceInput
                onTranscript={(text) =>
                  setDraft((prior) => {
                    const next = prior ? prior + ' ' + text : text;
                    localStorage.setItem('workspace-draft-' + (selected || 'new'), next);
                    return next;
                  })
                }
                contextKey={selected}
              />
              <ComposerControls
                catalogs={worker?.modelOptions || []}
                adapters={state.adapters.map((value: Row) => ({
                  ...value,
                  available:
                    worker?.id === 'local'
                      ? value.available
                      : !!worker?.capabilities?.includes(value.id),
                }))}
                adapter={adapter}
                models={models as { id: string; name: string }[]}
                model={model}
                efforts={efforts}
                effort={effort}
                disabled={Boolean(active)}
                chooseAdapter={chooseAdapter}
                chooseModel={chooseModel}
                chooseEffort={setEffort}
              />
            </div>
            {active ? (
              <button
                className="pw-send"
                aria-label="Stop task"
                title="Stop task"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await api('/tasks/' + selected + '/stop', { revision: detail!.task.revision });
                  })
                }
              >
                <WorkspaceIcon name="stop" />
              </button>
            ) : (
              <button
                className="pw-send"
                aria-label={selected ? 'Send message' : 'Start task'}
                title={selected ? 'Send message (⌘ Enter)' : 'Start task (⌘ Enter)'}
                disabled={!canSend}
                onClick={() => void send()}
              >
                <WorkspaceIcon name="arrow" />
              </button>
            )}
          </div>
          <div className="pw-composer-caption">
            <span>
              {worker?.status !== 'online' ? (
                <>
                  Task computer offline.{' '}
                  <Link to="/dashboard/settings#settings-providers">Set up task worker</Link>
                </>
              ) : worker.id !== 'local' && !worker.capabilities?.includes(adapter) ? (
                <>
                  <Link to="/dashboard/settings#settings-providers">Connect a provider</Link> to
                  start coding.
                </>
              ) : (
                ''
              )}
            </span>
            <span>⌘ Return to send</span>
          </div>
        </div>
      </section>
      {surface && (
        <section className="pw-surface" aria-label={`${surfaceTitle} workspace`}>
          <div className="pw-surface-content">{surface}</div>
        </section>
      )}
      {!surface && !repositoryView && selected && (
        <ControlPanel
          key={selected}
          taskId={selected}
          workers={state.workers}
          api={api}
          onReveal={() => setControlVisible(true)}
          visible={controlVisible}
          onClose={() => setControlVisible(false)}
        />
      )}
      <aside className="pw-context ds-work-pane" aria-label="Code review">
        <header className="ds-pane-toolbar">
          <button
            className="pw-mobile-menu"
            aria-label="Show sidebar"
            onClick={() => setSidebar(!sidebar)}
          >
            <WorkspaceIcon name="sidebar" />
          </button>
          <strong>{detail?.task.title || 'Code review'}</strong>
        </header>
        {panel === 'changes' ? (
          <>
            <p className="pw-muted">
              {patch?.baseRevision?.slice(0, 12)}{' '}
              <WorkspaceIcon name="arrow-right" className="pw-inline-icon" />{' '}
              {patch?.headRevision === patch?.baseRevision
                ? 'Working tree'
                : patch?.headRevision?.slice(0, 12)}
            </p>
            {patchError && (
              <p role="status" className="pw-muted">
                {patchError}
              </p>
            )}
            <div className="pw-files">
              {patch?.files?.length ? (
                patch.files.map((file: Row) => (
                  <div key={file.path}>
                    <span className="pw-file-status">{file.status.trim() || 'M'}</span>
                    <span>{file.path}</span>
                  </div>
                ))
              ) : (
                <p className="pw-muted">
                  {patch
                    ? patch.status || 'Your working tree is clean.'
                    : patchError
                      ? 'Changes unavailable.'
                      : 'Loading changes…'}
                </p>
              )}
            </div>
            {patch?.patch && (
              <section className="pw-diff" aria-label="Code diff">
                <pre tabIndex={0} aria-label="Code changes">
                  {patch.patch.split('\n').map((line: string, i: number) => (
                    <span
                      key={i}
                      className={
                        line.startsWith('+') ? 'pw-added' : line.startsWith('-') ? 'pw-removed' : ''
                      }
                    >
                      {line}
                      {'\n'}
                    </span>
                  ))}
                </pre>
              </section>
            )}
            {patch?.truncated && (
              <p className="pw-muted">
                Patch truncated; inspect full files on the execution computer.
              </p>
            )}
            <h3>Checks</h3>
            {patch?.checks?.length ? (
              patch.checks.map((c: Row) => (
                <details className="pw-check" key={c.id}>
                  <summary>
                    <span
                      className={`pw-check-icon ${c.exitCode === 0 ? 'passed' : c.exitCode != null ? 'failed' : ''}`}
                    >
                      <WorkspaceIcon
                        name={c.exitCode === 0 ? 'check' : c.exitCode != null ? 'close' : 'circle'}
                      />
                    </span>
                    <span>
                      <strong>{c.command}</strong>
                      <small>
                        {c.exitCode === 0
                          ? 'Passed'
                          : c.exitCode != null
                            ? `Exited with code ${c.exitCode}`
                            : c.status || 'Running'}
                      </small>
                    </span>
                    <WorkspaceIcon name="chevron-down" className="pw-disclosure" />
                  </summary>
                  <pre>{checkOutput(c.output)}</pre>
                </details>
              ))
            ) : (
              <p className="pw-muted">
                {detail?.jobs?.length ? 'Checkpoint jobs' : 'No checks recorded'}
              </p>
            )}
            {detail?.jobs?.map((job: Row) => (
              <details className="pw-check" key={job.id}>
                <summary>
                  <span
                    className={`pw-check-icon ${job.status === 'succeeded' ? 'passed' : job.status === 'failed' ? 'failed' : ''}`}
                  >
                    <WorkspaceIcon
                      name={
                        job.status === 'succeeded'
                          ? 'check'
                          : job.status === 'failed'
                            ? 'close'
                            : 'circle'
                      }
                    />
                  </span>
                  <span>
                    <strong>{job.command}</strong>
                    <small>
                      Checkpoint {job.digest.slice(0, 12)} · {job.status.replaceAll('_', ' ')}
                      {job.exitCode != null ? ` · Exit ${job.exitCode}` : ''}
                    </small>
                  </span>
                  <WorkspaceIcon name="chevron-down" className="pw-disclosure" />
                </summary>
                {job.output && <pre>{job.output}</pre>}
                {job.truncated && <p className="pw-muted">Showing the last 64,000 characters.</p>}
                {job.error && <p role="alert">{job.error}</p>}
              </details>
            ))}
            {detail?.task.workerId && detail.task.workerId !== 'local' ? (
              <p className="pw-muted">
                Ask the task to run checks using checkpoint jobs on its computer.
              </p>
            ) : (
              <>
                <input
                  aria-label="Check command"
                  placeholder="Check command, e.g. npm test"
                  value={checkCommand}
                  onChange={(e) => setCheckCommand(e.target.value)}
                />
                <button
                  disabled={
                    !detail ||
                    !checkCommand ||
                    active ||
                    busy ||
                    worker?.status !== 'online' ||
                    (detail.task.workerId && detail.task.workerId !== 'local')
                  }
                  onClick={() => {
                    const command = checkCommand.trim();
                    if (command)
                      void action(async () => {
                        await api('/tasks/' + selected + '/check', {
                          revision: detail!.task.revision,
                          command,
                        });
                      });
                  }}
                >
                  Run check
                </button>
              </>
            )}
          </>
        ) : (
          <>
            {detail?.activity?.map((a: Row) => (
              <TaskActivity key={a.id} activity={a} />
            ))}
            {detail?.activity && <TaskSources activity={detail.activity} />}
            <details className="pw-task-activity">
              <summary>Technical event log</summary>
              {detail?.events.slice(-60).map((e: Row) => (
                <details key={e.cursor}>
                  <summary className="pw-muted">{e.type}</summary>
                  <dl className="pw-event-fields">
                    {Object.entries(e.payload || {})
                      .filter(([key]) => !['operationId', 'taskId', 'runId'].includes(key))
                      .map(([key, value]) => (
                        <div key={key}>
                          <dt>{key.replace(/([A-Z])/g, ' $1')}</dt>
                          <dd>{typeof value === 'object' ? checkOutput(value) : String(value)}</dd>
                        </div>
                      ))}
                  </dl>
                </details>
              ))}
            </details>
          </>
        )}
      </aside>
      {repositoryView && projectHub && (
        <ProjectHub
          key={projectHub.id}
          projects={state.projects}
          chooseProject={setProjectHub}
          project={projectHub}
          initialTab={projectHub.initialTab}
          api={api}
          close={() => setProjectHub(null)}
          openTask={(id) => {
            setProjectHub(null);
            returnToChat();
            setSelected(id);
            void refresh().catch(() => {});
          }}
        />
      )}
      {repositoryView && !projectHub && (
        <>
          <aside
            className="pw-sidebar ds-context-sidebar ds-repository-context"
            aria-label="Repository navigation"
          >
            <header className="ds-context-heading">
              <strong>Repositories</strong>
            </header>
            <p className="ds-context-hint">
              Create a project to browse its source, issues and pull requests.
            </p>
          </aside>
          <section className="ds-work-pane ds-repository-empty" aria-label="Repository workspace">
            <header className="ds-pane-toolbar ds-empty-navigation">
              <button
                className="pw-mobile-menu"
                aria-label="Show sidebar"
                onClick={() => setSidebar(!sidebar)}
              >
                <WorkspaceIcon name="sidebar" />
              </button>
            </header>
            <div className="ds-feedback" role={connectionError ? 'alert' : 'status'}>
              <WorkspaceIcon name="folder" />
              <span>{connectionError || 'No repositories yet'}</span>
              {connectionError ? (
                <button onClick={() => void refresh().catch(() => {})}>Retry</button>
              ) : (
                <button onClick={() => setCreatingProject(true)}>Create project</button>
              )}
            </div>
          </section>
        </>
      )}
      <dialog
        ref={projectDialogRef}
        className="pw-project-dialog"
        onCancel={() => setCreatingProject(false)}
        onClose={() => setCreatingProject(false)}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              const p = await api('/projects', {
                name: name.trim(),
                sourcePath: source.trim() || undefined,
              });
              setName('');
              setSource('');
              setCreatingProject(false);
              newTask(p.id);
            });
          }}
        >
          <div className="pw-dialog-heading">
            <h2>Create project</h2>
            <button
              type="button"
              className="pw-icon-button"
              aria-label="Close"
              onClick={() => setCreatingProject(false)}
            >
              <WorkspaceIcon name="close" />
            </button>
          </div>
          <p>Keep related tasks together in a shared repository.</p>
          <label>
            Project name
            <input
              autoFocus
              required
              aria-label="Project name"
              placeholder="My project"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Repository <span className="pw-muted">(optional)</span>
            <input
              aria-label="Repository source"
              placeholder="Local path or Git URL"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
          </label>
          <p className="pw-muted">Leave blank to start with an empty repository.</p>
          {error && (
            <p className="pw-error" role="alert">
              {error}
            </p>
          )}
          <div className="pw-dialog-actions">
            <button type="button" onClick={() => setCreatingProject(false)}>
              Cancel
            </button>
            <button className="pw-primary" disabled={!name.trim() || busy}>
              Create project
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

function taskStatus(status: string) {
  return (
    (
      {
        review: 'Ready to review',
        ready: 'Ready',
        running: 'Working',
        checking: 'Running checks',
        queued: 'Queued',
        stopped: 'Stopped',
        failed: 'Needs attention',
      } as Record<string, string>
    )[status] || status
  );
}

function checkOutput(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object') {
    const item = value as Row;
    if (item.text || item.output || item.message)
      return String(item.text || item.output || item.message);
    if (Array.isArray(item.content)) return item.content.map(checkOutput).join('\n');
    return Object.entries(item)
      .map(([key, content]) => `${key}: ${checkOutput(content)}`)
      .join('\n');
  }
  const raw = String(value);
  try {
    return checkOutput(JSON.parse(raw));
  } catch {
    return raw;
  }
}
