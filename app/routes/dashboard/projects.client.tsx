'use client';
import { useEffect, useState, useRef, useMemo } from 'react';
import './workspace.css';
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
import { ProjectHub } from './project-hub.client';
import { ControlPanel } from './control-panel.client';
import { WorkspaceRail } from './workspace-rail.client';
import { MessageContent } from './message-content.client';
import { indexTranscript } from './transcript-index';
import { LoginForm } from './data.client';
import { getAuth } from './detail/shared';
type Row = Record<string, any>;
export default function ProjectsClient() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => {
    setAuthed(Boolean(getAuth()));
  }, []);
  if (authed === null) return <p>Connecting…</p>;
  if (!authed) return <LoginForm onLogin={() => setAuthed(true)} />;
  return <ProjectWorkspace />;
}
function ProjectWorkspace() {
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
    [draft, setDraft] = useState(''),
    [name, setName] = useState(''),
    [source, setSource] = useState(''),
    [search, setSearch] = useState(''),
    [collapsed, setCollapsed] = useState<Record<string, boolean>>({}),
    [creatingProject, setCreatingProject] = useState(false),
    [error, setError] = useState(''),
    [connectionError, setConnectionError] = useState(''),
    [busy, setBusy] = useState(false),
    [panel, setPanel] = useState('changes'),
    [inspector, setInspector] = useState(false),
    [controlVisible, setControlVisible] = useState(false),
    [sidebar, setSidebar] = useState(false),
    [checkCommand, setCheckCommand] = useState('');
  const [projectHub, setProjectHub] = useState<Row | null>(null);
  const transcriptIndex = useMemo(
    () => indexTranscript(detail?.messages ?? [], detail?.activity ?? []),
    [detail?.messages, detail?.activity],
  );
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followTranscript = useRef(true);
  useEffect(() => {
    followTranscript.current = true;
  }, [selected]);
  const composerRef = useRef<HTMLTextAreaElement>(null);
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
    if (selected) localStorage.setItem('workspace-selected-task', selected);
    else localStorage.removeItem('workspace-selected-task');
  }, [selected]);
  async function api(path: string, body?: Row, signal?: AbortSignal) {
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
  }
  async function refresh(signal?: AbortSignal) {
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
            loadedSettings.current = taskId;
          }
          setDetail(nextDetail);
          // Conversation deltas should not wait for a Git diff to finish.
          const nextPatch = await api('/tasks/' + taskId + '/diff', undefined, signal);
          if (
            !signal?.aborted &&
            generation === refreshGeneration.current &&
            selectedRef.current === taskId
          )
            setPatch(nextPatch);
        }
      }
      setConnectionError('');
    } catch (failure) {
      if (signal?.aborted || generation !== refreshGeneration.current) return;
      setConnectionError(workspaceConnectionMessage(failure));
      throw failure;
    }
  }
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
  }, [needsAuthentication]);
  useEffect(() => {
    setDetail(null);
    setPatch(null);
    setDraft(localStorage.getItem('workspace-draft-' + (selected || 'new')) || '');
    if (selected) void refresh().catch(() => {});
  }, [selected]);
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
  const fileCount = patch?.status?.split('\n').filter(Boolean).length || 0;
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
    (!selected || detail),
  );
  const matches = (task: Row) => task.title.toLowerCase().includes(search.toLowerCase());
  const tasks = [...state.tasks].sort((a: Row, b: Row) =>
    String(b.updatedAt).localeCompare(String(a.updatedAt)),
  );
  function newTask(projectId = '') {
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
        if (project) setCollapsed((prior) => ({ ...prior, [project]: false }));
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
      className={`project-workspace ${!selected ? 'is-composing' : ''} ${inspector ? 'has-inspector' : ''} ${sidebar ? 'show-sidebar' : ''}`}
    >
      <WorkspaceRail workers={state.workers} workerId={worker?.id} />
      {sidebar && (
        <button
          className="pw-sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside className="pw-sidebar" aria-label="Workspace navigation">
        <label className="pw-search">
          <WorkspaceIcon name="search" />
          <input
            aria-label="Search tasks"
            placeholder="Search tasks"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <nav className="pw-task-tree" aria-label="Tasks and projects">
          <div className="pw-section-heading">
            <h3>Tasks</h3>
          </div>
          {tasks.filter((t: Row) => !t.projectId && matches(t)).map((t: Row) => taskRow(t))}
          {!tasks.some((t: Row) => !t.projectId && matches(t)) && (
            <p className="pw-tree-empty">
              {search ? 'No matching tasks' : 'Tasks without a project appear here'}
            </p>
          )}
          <div className="pw-section-heading">
            <h3>Projects</h3>
            <button
              className="pw-icon-button"
              aria-label="Create project"
              title="Create project"
              onClick={() => setCreatingProject(true)}
            >
              <WorkspaceIcon name="plus" />
            </button>
          </div>
          {state.projects
            .filter(
              (p: Row) =>
                !search ||
                p.name.toLowerCase().includes(search.toLowerCase()) ||
                tasks.some((t: Row) => t.projectId === p.id && matches(t)),
            )
            .map((p: Row) => {
              const children = tasks.filter((t: Row) => t.projectId === p.id && matches(t));
              const expanded = Boolean(search) || !collapsed[p.id];
              return (
                <div className="pw-project-group" key={p.id}>
                  <div className="pw-project-row">
                    <button
                      className="pw-project-disclosure"
                      aria-label={`${expanded ? 'Collapse' : 'Expand'} ${p.name}`}
                      aria-expanded={expanded}
                      aria-controls={`project-${p.id}`}
                      onClick={() => setCollapsed((prior) => ({ ...prior, [p.id]: !prior[p.id] }))}
                    >
                      <WorkspaceIcon name="chevron" className={expanded ? 'is-expanded' : ''} />
                    </button>
                    <button
                      className="pw-project-toggle"
                      onClick={() => setProjectHub(p)}
                      aria-label={`Open ${p.name} project`}
                      title="Open project overview"
                    >
                      <WorkspaceIcon name="folder" />
                      <span>{p.name}</span>
                    </button>
                    <button
                      className="pw-icon-button pw-project-add"
                      aria-label={`New task in ${p.name}`}
                      title={`New task in ${p.name}`}
                      onClick={() => newTask(p.id)}
                    >
                      <WorkspaceIcon name="plus" />
                    </button>
                  </div>
                  {expanded && (
                    <div id={`project-${p.id}`} className="pw-project-tasks">
                      <button
                        className="pw-new-project-task"
                        onClick={() => newTask(p.id)}
                        aria-label={`Create task in ${p.name}`}
                      >
                        New task
                      </button>
                      {children.map((t: Row) => taskRow(t, true))}
                    </div>
                  )}
                </div>
              );
            })}
          {!state.projects.length && (
            <button className="pw-empty-project" onClick={() => setCreatingProject(true)}>
              Create your first project
            </button>
          )}
        </nav>
        <div className="pw-task-create">
          <button className="pw-new-task" onClick={() => newTask()}>
            <WorkspaceIcon name="compose" />
            New task
          </button>
        </div>
      </aside>
      <section className="pw-chat">
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
                  <span>{worker?.name || detail.task.workerId || 'Local'}</span>
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
            {!selected && (
              <div className="pw-empty">
                <h1>What would you like to work on?</h1>
                <p>Start a task, with or without a project.</p>
              </div>
            )}
            {detail && !detail.messages.length && (
              <div className="pw-empty">
                <h1>{detail.task.title}</h1>
                <p>Give your agent a place to start.</p>
              </div>
            )}
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
              <label className="pw-select">
                <WorkspaceIcon name="folder" />
                <span className="pw-select-value" aria-hidden="true">
                  {state.projects.find((p: Row) => p.id === project)?.name || 'No project'}
                </span>
                <WorkspaceIcon name="chevron-down" />
                <select
                  aria-label="Task project"
                  value={project}
                  onChange={(e) => setProject(e.target.value)}
                >
                  <option value="">No project</option>
                  {state.projects.map((p: Row) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="pw-select">
                <WorkspaceIcon name="computer" />
                <span className="pw-select-value" aria-hidden="true">
                  {workerId === 'local' ? 'Local' : worker?.name || 'Computer'}
                  {worker?.status !== 'online' ? ' (offline)' : ''}
                </span>
                <WorkspaceIcon name="chevron-down" />
                <select
                  aria-label="Execution computer"
                  value={workerId}
                  onChange={(e) => setWorkerId(e.target.value)}
                >
                  {state.workers.map((w: Row) => (
                    <option key={w.id} value={w.id}>
                      {w.id === 'local' ? 'Local' : w.name}
                      {w.status !== 'online' ? ' (offline)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <div className="pw-composer">
            <textarea
              ref={composerRef}
              aria-label="Message"
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
                adapters={state.adapters}
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
            <span>{worker?.status !== 'online' ? 'Execution computer is offline' : ''}</span>
            <span>⌘ Return to send</span>
          </div>
        </div>
      </section>
      {selected && (
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
      <aside className="pw-context" aria-label="Task inspector">
        <div className="pw-tabs">
          <button aria-pressed={panel === 'changes'} onClick={() => setPanel('changes')}>
            Changes
          </button>
          <button
            aria-pressed={panel === 'control'}
            onClick={() => {
              setControlVisible(true);
              setInspector(false);
            }}
          >
            Controls
          </button>
          <button aria-pressed={panel === 'activity'} onClick={() => setPanel('activity')}>
            Activity
          </button>
        </div>
        {panel === 'changes' ? (
          <>
            <h3>Working changes</h3>
            <p className="pw-muted">
              {patch?.baseRevision?.slice(0, 12)}{' '}
              <WorkspaceIcon name="arrow-right" className="pw-inline-icon" />{' '}
              {patch?.headRevision?.slice(0, 12)}
            </p>
            <div className="pw-files">
              {patch?.status ? (
                patch.status
                  .split('\n')
                  .filter(Boolean)
                  .map((line: string, i: number) => (
                    <div key={i}>
                      <span className="pw-file-status">{line.slice(0, 2).trim() || 'M'}</span>
                      <span>{line.slice(3)}</span>
                    </div>
                  ))
              ) : (
                <p className="pw-muted">Your working tree is clean.</p>
              )}
            </div>
            {patch?.patch && (
              <details className="pw-diff">
                <summary>View diff</summary>
                <pre>
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
              </details>
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
              <p className="pw-muted">No checks recorded</p>
            )}
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
      {projectHub && (
        <ProjectHub
          project={projectHub}
          api={api}
          close={() => setProjectHub(null)}
          openTask={(id) => {
            setProjectHub(null);
            setSelected(id);
            void refresh().catch(() => {});
          }}
        />
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
