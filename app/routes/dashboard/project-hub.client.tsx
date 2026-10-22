'use client';
import { WorkspaceTitleBar } from './workspace-title-bar.client';
import { IconButton } from '@/components/ui';

import { Button, Select, StatusBadge } from '@/components/ui';
import { RepositoryWorkbench } from './repository-workbench.client';
import { taskStatus } from './task-tree';
import { WorkspaceIcon } from './workspace-icon';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useRouter } from 'react-flight-router/client';
import { repositoryURL, type RepositorySection } from './repository-navigation';
import { RepositorySettings } from './repository-settings.client';
import { MessageContent } from './message-content.client';
import { RepositoryDeploymentView } from './repository-deployment.client';
type Row = Record<string, any>;
const repositoryMemory = new Map<string, Record<string, any>>();
type API = (path: string, body?: Row) => Promise<any>;
export function ProjectHub({
  project,
  tasks,
  api,
  openTask,
  section = 'repository',
  refreshProject,
  updateProject,
  startTask,
  initialSelected,
  returnTask,
}: {
  initialSelected?: string;
  returnTask?: string;
  project: Row;
  tasks: Row[];
  api: API;
  openTask: (id: string) => void;
  section?: RepositorySection;
  refreshProject: () => Promise<void>;
  updateProject: (project: Row) => void;
  startTask: (ref: string, path?: string) => void;
}) {
  const { navigate, url } = useRouter();
  const navigationRef = useRef<HTMLElement>(null);
  const saved = useRef(repositoryMemory.get(project.id)).current;
  const tabMemory = useRef<Record<string, Row>>(saved?.tabs || {});
  const [tab, setTab] = useState<string>(section),
    [items, setItems] = useState<Row[]>([]),
    [selected, setSelected] = useState(
      initialSelected ||
        (saved?.tab === section ? saved?.selected || '' : saved?.tabs?.[section]?.selected || ''),
    );
  const [detail, setDetail] = useState<Row | null>(null),
    [comparison, setComparison] = useState<Row | null>(null);
  const [repository, setRepository] = useState<Row | null>(null);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [creating, setCreating] = useState(false),
    [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(''),
    [body, setBody] = useState(''),
    [comment, setComment] = useState('');
  const [source, setSource] = useState(''),
    [target, setTarget] = useState('main'),
    [branch, setBranch] = useState(saved?.branch || 'HEAD');
  const base = `/projects/${project.id}`;
  const current = useRef({ tab, selected, branch, detail, comparison, items });
  current.current = { tab, selected, branch, detail, comparison, items };
  useEffect(() => {
    repositoryMemory.set(project.id, {
      tab,
      selected,
      tabs: tabMemory.current,
      branch,
    });
  }, [project.id, tab, selected, branch]);
  const applyTab = useCallback((next: string) => {
    const active = current.current;
    if (active.tab === next) return;
    tabMemory.current[active.tab] = {
      selected: active.selected,
      detail: active.detail,
      comparison: active.comparison,
      items: active.items,
    };
    const memory = tabMemory.current[next];
    setTab(next);
    setSelected(memory?.selected || '');
    setDetail(memory?.detail || null);
    setComparison(memory?.comparison || null);
    setCreating(false);
    setItems(memory?.items || []);
    setError('');
  }, []);

  useLayoutEffect(() => applyTab(section), [section, applyTab]);
  useEffect(() => {
    if (initialSelected) {
      setTab('pulls');
      setSelected(initialSelected);
      setCreating(false);
    }
  }, [initialSelected]);
  useEffect(() => {
    if (!returnTask) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !busy) openTask(returnTask);
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [returnTask, openTask, busy]);
  const chooseTab = useCallback(
    (next: string) => {
      void navigate(repositoryURL(project.id, next));
    },
    [navigate, project.id],
  );
  const refresh = useCallback(async () => {
    const expected = { ...current.current };
    setError('');
    try {
      const repo = await api(base + '/repository');
      setRepository(repo);
      if (current.current.tab !== expected.tab) return;
      if (['pipelines', 'deployment'].includes(expected.tab) && !repo.deployment?.configured) {
        chooseTab('repository');
        return;
      }
      if (expected.tab === 'deployment') return;
      if (expected.tab === 'pipelines' && !repo.deployment?.pipeline) {
        chooseTab('deployment');
        return;
      }
      if (['repository', 'settings'].includes(expected.tab)) return;
      const data = await api(base + '/' + expected.tab);
      if (current.current.tab !== expected.tab) return;
      setItems(expected.tab === 'pipelines' ? data.runs : data.items);
      if (expected.selected) {
        const next = await api(base + '/' + expected.tab + '/' + expected.selected);
        if (current.current.selected !== expected.selected || current.current.tab !== expected.tab)
          return;
        setDetail(next);
        if (expected.tab === 'pulls') {
          const diff = await api(base + '/pulls/' + expected.selected + '/diff');
          if (current.current.selected === expected.selected) setComparison(diff);
        }
      }
    } catch (e: any) {
      setError(e.message);
    }
  }, [api, base, chooseTab]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [tab, selected, branch, refresh]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const row = detail?.record;
  const hasPipeline = Boolean(repository?.deployment?.pipeline);
  const hasDeployment = Boolean(repository?.deployment?.configured);
  useLayoutEffect(() => {
    navigationRef.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tab, hasPipeline, hasDeployment]);
  const branches =
    repository?.refs
      ?.filter((ref: Row) => ref.name.startsWith('refs/heads/'))
      .map((ref: Row) => ref.name.slice(11)) || [];
  return (
    <section
      className={`pw-project-hub repository-workspace ${returnTask ? 'task-pull-workspace' : ''}`}
      aria-label={`${project.name} repository`}
    >
      {!returnTask && (
        <aside className="ph-navigation ds-context-sidebar">
          <header className="ds-context-heading rm-context-heading">
            <Link className="rm-back" to="/dashboard/repositories">
              <WorkspaceIcon name="chevron-left" />
              Repositories
            </Link>
          </header>
          <strong className="rm-project-name">{project.name}</strong>
          <nav
            ref={navigationRef}
            className="ph-tabs ds-context-links"
            aria-label="Project sections"
          >
            {[
              ['repository', 'Files'],
              ['issues', 'Issues'],
              ['pulls', 'Pull requests'],
              ...(hasPipeline ? [['pipelines', 'Pipelines']] : []),
              ...(hasDeployment ? [['deployment', 'Deployment']] : []),
              ['settings', 'Settings'],
            ].map(([key, label]) => (
              <Link
                key={key}
                to={repositoryURL(project.id, key)}
                aria-current={tab === key ? 'page' : undefined}
              >
                {label}
              </Link>
            ))}
          </nav>
        </aside>
      )}
      <section className="ph-work ds-work-pane">
        <WorkspaceTitleBar
          className="desktop-only"
          title={detail?.title || project.name}
          prefix={{ title: 'Repositories', href: '/dashboard/repositories' }}
        />
        {error && (
          <p className="ph-error" role="alert">
            {error}
            <IconButton icon="refresh" label="Retry" onClick={() => void refresh()} />
          </p>
        )}
        {tab === 'settings' ? (
          <RepositorySettings
            project={project}
            repository={repository}
            updateProject={updateProject}
            api={api}
            refresh={async () => {
              await Promise.all([refresh(), refreshProject()]);
            }}
          />
        ) : tab === 'deployment' ? (
          <RepositoryDeploymentView configuration={repository?.deployment} />
        ) : tab === 'repository' ? (
          <RepositoryWorkbench
            key={url}
            tasks={tasks}
            project={project}
            repository={repository}
            api={api}
            branch={branch}
            setBranch={setBranch}
            startTask={startTask}
            refreshRepository={refresh}
          />
        ) : (
          <div
            className={`ph-layout ${selected || creating ? 'has-detail' : ''} ${creating ? 'is-creating' : ''}`}
          >
            <div className="ph-list">
              <div className="ph-list-toolbar">
                <span className="pw-muted">
                  {items.length}{' '}
                  {tab === 'pulls'
                    ? items.length === 1
                      ? 'pull request'
                      : 'pull requests'
                    : tab === 'pipelines'
                      ? items.length === 1
                        ? 'run'
                        : 'runs'
                      : items.length === 1
                        ? 'issue'
                        : 'issues'}
                </span>
                <button
                  disabled={busy}
                  onClick={() => {
                    setCreating(true);
                    setEditing(false);
                    setSelected('');
                    setDetail(null);
                    setTitle('');
                    setBody('');
                    setSource(
                      branches.find((b: string) => b !== (repository?.defaultBranch || 'main')) ||
                        '',
                    );
                    setTarget(repository?.defaultBranch || 'main');
                  }}
                >
                  {tab === 'pipelines'
                    ? 'Run pipeline'
                    : tab === 'pulls'
                      ? 'New pull request'
                      : 'New issue'}
                </button>
              </div>
              {!items.length && (
                <p className="ph-empty">
                  {tab === 'pipelines'
                    ? 'Add a pipeline to deploy.yaml, then run it here or push a commit.'
                    : tab === 'pulls'
                      ? 'Open a pull request to review and merge a branch.'
                      : 'Capture work to tackle, then start a coding task when you’re ready.'}
                </p>
              )}
              {items.map((item) => (
                <button
                  className={`ph-list-row ${selected === item.id ? 'is-selected' : ''}`}
                  key={item.id}
                  onClick={() => {
                    setSelected(item.id);
                    setDetail(null);
                    setComparison(null);
                    setCreating(false);
                  }}
                >
                  <span className={`ph-status ${item.status}`}>
                    <WorkspaceIcon
                      name={
                        item.status === 'succeeded' || item.status === 'merged'
                          ? 'check'
                          : item.status === 'failed'
                            ? 'alert'
                            : 'circle'
                      }
                    />
                  </span>
                  <span>
                    <strong>
                      {item.title ||
                        `${item.trigger === 'manual' ? 'Manual run' : item.trigger === 'push' ? 'Push' : 'Pull request'} ${item.commit.slice(0, 7)}`}
                    </strong>
                    <small>
                      {item.number ? `#${item.number} · ` : ''}
                      {tab === 'pipelines' && item.deployment
                        ? `Checks ${item.status} · ${deploymentLabel(item)}`
                        : item.status}{' '}
                      · {new Date(item.createdAt).toLocaleDateString()}
                    </small>
                  </span>
                </button>
              ))}
            </div>
            {(selected || creating) && (
              <div className="ph-detail">
                <IconButton
                  icon="back"
                  label={returnTask ? 'Back to task' : 'Back to list'}
                  className="ph-back"
                  onClick={() => {
                    if (returnTask) {
                      openTask(returnTask);
                      return;
                    }
                    setSelected('');
                    setCreating(false);
                  }}
                />
                {creating ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void action(async () => {
                        const result = await api(
                          editing
                            ? base + '/' + tab + '/' + selected + '/update'
                            : base + '/' + tab,
                          tab === 'pipelines'
                            ? { ref: branch }
                            : {
                                title,
                                body,
                                ...(editing ? { revision: row.revision } : {}),
                                ...(tab === 'pulls' && !editing
                                  ? { sourceBranch: source, targetBranch: target }
                                  : {}),
                              },
                        );
                        setCreating(false);
                        setEditing(false);
                        setSelected(result.id);
                      });
                    }}
                  >
                    <h3>
                      {editing
                        ? 'Edit ' + (tab === 'pulls' ? 'pull request' : 'issue')
                        : tab === 'pipelines'
                          ? 'Run pipeline'
                          : tab === 'pulls'
                            ? 'New pull request'
                            : 'New issue'}
                    </h3>
                    {tab === 'pipelines' ? (
                      <label>
                        Branch
                        <Select value={branch} onChange={(e) => setBranch(e.target.value)}>
                          <option value="HEAD">Default branch</option>
                          {branches.map((b: string) => (
                            <option key={b}>{b}</option>
                          ))}
                        </Select>
                      </label>
                    ) : (
                      <>
                        <label>
                          Title
                          <input
                            required
                            maxLength={300}
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            autoFocus
                          />
                        </label>
                        <label>
                          Description
                          <textarea
                            rows={6}
                            value={body}
                            onChange={(e) => setBody(e.target.value)}
                          />
                        </label>
                      </>
                    )}
                    {tab === 'pulls' && !editing && (
                      <div className="ph-branches">
                        <label>
                          Source
                          <Select
                            required
                            value={source}
                            onChange={(e) => setSource(e.target.value)}
                          >
                            <option value="">Choose branch</option>
                            {branches.map((b: string) => (
                              <option key={b}>{b}</option>
                            ))}
                          </Select>
                        </label>
                        <WorkspaceIcon name="arrow-right" />
                        <label>
                          Target
                          <Select value={target} onChange={(e) => setTarget(e.target.value)}>
                            {branches.map((b: string) => (
                              <option key={b}>{b}</option>
                            ))}
                          </Select>
                        </label>
                      </div>
                    )}
                    <button
                      className="ph-primary"
                      disabled={busy || (!editing && tab === 'pulls' && source === target)}
                    >
                      {busy
                        ? 'Working…'
                        : editing
                          ? 'Save changes'
                          : tab === 'pipelines'
                            ? 'Run pipeline'
                            : 'Create'}
                    </button>
                  </form>
                ) : !detail ? (
                  <p className="pw-muted">Loading…</p>
                ) : tab === 'pipelines' ? (
                  <>
                    <h3>
                      {detail.pipeline.trigger === 'manual'
                        ? 'Manual pipeline'
                        : 'Pipeline from ' + detail.pipeline.trigger}
                    </h3>
                    <p className="pw-muted">
                      {detail.pipeline.commit.slice(0, 12)} · {detail.pipeline.status}
                    </p>
                    {!['succeeded', 'failed', 'cancelled'].includes(detail.pipeline.status) && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            await api(base + '/pipelines/' + selected + '/cancel', {});
                          })
                        }
                      >
                        Cancel run
                      </button>
                    )}
                    {detail.jobs.map((job: Row) => (
                      <details key={job.id} className="ph-job" open={job.status === 'failed'}>
                        <summary>
                          <strong>{job.name}</strong>
                          <span>
                            {job.workerId || 'Waiting for computer'} · {job.status}
                          </span>
                        </summary>
                        <code>{job.command}</code>
                        {job.waitingReason && <p className="pw-muted">{job.waitingReason}</p>}
                        <pre>{job.output || job.error || 'No output yet'}</pre>
                      </details>
                    ))}
                    {detail.pipeline.deployment && (
                      <section className="ph-deployment">
                        <h4>Deployment</h4>
                        <p>
                          {detail.pipeline.deployment.application} ·{' '}
                          {deploymentLabel(detail.pipeline, true)}
                        </p>
                        {detail.pipeline.deployment.releaseId && (
                          <code>Release {detail.pipeline.deployment.releaseId}</code>
                        )}
                        {detail.pipeline.deployment.error && (
                          <p role="alert">{detail.pipeline.deployment.error}</p>
                        )}
                        {detail.pipeline.deployment.receipt?.failure && (
                          <p>{detail.pipeline.deployment.receipt.failure}</p>
                        )}
                      </section>
                    )}
                  </>
                ) : (
                  row && (
                    <>
                      <div className="ph-record-heading">
                        <span className="pw-muted">
                          #{row.number} · {row.status}
                        </span>
                        <h3>{row.title}</h3>
                        {tab === 'pulls' && (
                          <p className="pw-muted">
                            {row.sourceBranch}{' '}
                            <WorkspaceIcon name="arrow-right" className="pw-inline-icon" />{' '}
                            {row.targetBranch}
                          </p>
                        )}
                      </div>
                      <MessageContent content={row.body || 'No description yet.'} />
                      <div className="ph-actions">
                        {row.status !== 'merged' && (
                          <button
                            disabled={busy}
                            onClick={() => {
                              setTitle(row.title);
                              setBody(row.body);
                              setEditing(true);
                              setCreating(true);
                            }}
                          >
                            Edit
                          </button>
                        )}
                        {row.status !== 'merged' && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              void action(async () => {
                                await api(
                                  base +
                                    '/' +
                                    tab +
                                    '/' +
                                    selected +
                                    (row.status === 'open' ? '/close' : '/reopen'),
                                  { revision: row.revision },
                                );
                              })
                            }
                          >
                            {row.status === 'open' ? 'Close' : 'Reopen'}
                          </button>
                        )}
                        {tab === 'issues' && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              void action(async () => {
                                const result = await api(base + '/issues/' + selected + '/task', {
                                  revision: row.revision,
                                });
                                openTask(result.task.id);
                              })
                            }
                          >
                            Start task
                          </button>
                        )}
                        {tab === 'pulls' &&
                          row.status === 'open' &&
                          comparison &&
                          repository?.deployment?.pipeline && (
                            <button
                              disabled={busy}
                              onClick={() =>
                                void action(async () => {
                                  await api(base + '/pipelines', { pullId: selected });
                                })
                              }
                            >
                              Run checks
                            </button>
                          )}
                        {tab === 'pulls' && row.status === 'open' && comparison && (
                          <button
                            className="ph-primary"
                            disabled={busy || !comparison.fastForward}
                            onClick={() =>
                              void action(async () => {
                                await api(base + '/pulls/' + selected + '/merge', {
                                  revision: row.revision,
                                  baseCommit: comparison.baseCommit,
                                  headCommit: comparison.headCommit,
                                });
                              })
                            }
                          >
                            Merge pull request
                          </button>
                        )}
                      </div>
                      {detail.mergeOperation?.error && (
                        <p role="alert">{detail.mergeOperation.error}</p>
                      )}
                      {detail.mergeOperation?.status === 'unknown' && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void action(async () => {
                              await api(base + '/pulls/' + selected + '/retry-merge', {
                                revision: row.revision,
                              });
                            })
                          }
                        >
                          Recover merge
                        </button>
                      )}
                      {row.taskIds?.length > 0 && (
                        <div className="ph-links">
                          {row.taskIds.map((taskId: string) => {
                            const task = tasks.find((item) => item.id === taskId);
                            const status = taskStatus(task?.status || '', false, task?.pull);
                            return (
                              <div key={taskId}>
                                <Button variant="link" onClick={() => openTask(taskId)}>
                                  {task?.title || 'Open task'}
                                </Button>
                                {task && <StatusBadge tone={status.tone} label={status.label} />}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {detail.checks?.map((check: Row) => (
                        <p key={check.id} className="pw-muted">
                          Check {check.commit.slice(0, 7)} · {check.status}
                          {comparison && check.commit !== comparison.headCommit
                            ? ' · previous commit'
                            : ''}
                        </p>
                      ))}
                      {comparison && (
                        <details className="ph-diff">
                          <summary>
                            Changed files
                            {!comparison.fastForward && row.status === 'open'
                              ? ' · rebase needed'
                              : ''}
                          </summary>
                          <pre>{comparison.patch || 'No changes'}</pre>
                        </details>
                      )}
                      <div className="ph-comments">
                        {detail.comments.map((entry: Row) => (
                          <article key={entry.id}>
                            <small>
                              {entry.author} · {new Date(entry.createdAt).toLocaleString()}
                            </small>
                            <MessageContent content={entry.body} />
                          </article>
                        ))}
                      </div>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void action(async () => {
                            await api(base + '/' + tab + '/' + selected + '/comments', {
                              body: comment,
                            });
                            setComment('');
                          });
                        }}
                      >
                        <label>
                          Add a comment
                          <textarea
                            required
                            rows={3}
                            value={comment}
                            onChange={(e) => setComment(e.target.value)}
                          />
                        </label>
                        <button disabled={busy || !comment.trim()}>Comment</button>
                      </form>
                    </>
                  )
                )}
              </div>
            )}
          </div>
        )}
      </section>
    </section>
  );
}

function deploymentLabel(pipeline: Row, explainGate = false) {
  const status = pipeline.deployment?.status;
  if (status === 'waiting' && ['failed', 'cancelled'].includes(pipeline.status))
    return 'Not deployed' + (explainGate ? ' · checks ' + pipeline.status : '');
  if (status === 'succeeded') return 'Deployed';
  if (status === 'unknown') return 'Deployment needs attention';
  return 'Deployment ' + status;
}
