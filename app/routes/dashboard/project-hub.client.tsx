'use client';
import { WorkspaceIcon } from './workspace-icon';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageContent } from './message-content.client';
type Row = Record<string, any>;
type API = (path: string, body?: Row) => Promise<any>;
export function ProjectHub({
  project,
  api,
  close,
  openTask,
}: {
  project: Row;
  api: API;
  close: () => void;
  openTask: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState('issues'),
    [items, setItems] = useState<Row[]>([]),
    [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<Row | null>(null),
    [comparison, setComparison] = useState<Row | null>(null);
  const [repository, setRepository] = useState<Row | null>(null),
    [file, setFile] = useState<Row | null>(null),
    [tree, setTree] = useState<Row[]>([]);
  const [folder, setFolder] = useState('');
  const folderRef = useRef('');
  folderRef.current = folder;
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [creating, setCreating] = useState(false),
    [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(''),
    [body, setBody] = useState(''),
    [comment, setComment] = useState('');
  const [source, setSource] = useState(''),
    [target, setTarget] = useState('main'),
    [branch, setBranch] = useState('HEAD');
  const base = `/projects/${project.id}`;
  const current = useRef({ tab, selected });
  current.current = { tab, selected };
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const refresh = useCallback(async () => {
    const expected = { ...current.current };
    try {
      const repo = await api(base + '/repository');
      setRepository(repo);
      if (expected.tab === 'repository') {
        if (repo.status === 'ready') {
          const listing = await api(
            base + '/repository/tree?path=' + encodeURIComponent(folderRef.current),
          );
          if (current.current.tab === expected.tab) setTree(listing.entries);
        }
        return;
      }
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
  }, [api, base]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [tab, selected, refresh]);
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
  function chooseTab(next: string) {
    setTab(next);
    setSelected('');
    setDetail(null);
    setComparison(null);
    setCreating(false);
    setItems([]);
    setError('');
  }
  const row = detail?.record;
  const branches =
    repository?.refs
      ?.filter((ref: Row) => ref.name.startsWith('refs/heads/'))
      .map((ref: Row) => ref.name.slice(11)) || [];
  return (
    <dialog
      ref={dialog}
      className="pw-project-hub"
      aria-label={`${project.name} project`}
      onCancel={close}
    >
      <header className="ph-heading">
        <div>
          <span className="pw-muted">Project</span>
          <h2>{project.name}</h2>
        </div>
        <button onClick={close} aria-label="Close project">
          <WorkspaceIcon name="close" />
        </button>
      </header>
      <nav className="ph-tabs" aria-label="Project sections">
        {[
          ['repository', 'Repository'],
          ['issues', 'Issues'],
          ['pulls', 'Pull requests'],
          ['pipelines', 'Pipelines'],
        ].map(([key, label]) => (
          <button
            key={key}
            aria-current={tab === key ? 'page' : undefined}
            onClick={() => chooseTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>
      {error && (
        <p className="ph-error" role="alert">
          {error}
        </p>
      )}
      {tab === 'repository' ? (
        <div className="ph-repository">
          <h3>{repository?.status === 'ready' ? 'Repository' : 'Preparing repository'}</h3>
          <p className="pw-muted">{repository?.source?.location || 'Hosted in deploy.local'}</p>
          {repository?.clonePath && (
            <label>
              Clone URL
              <input
                readOnly
                value={window.location.origin + repository.clonePath}
                onFocus={(e) => e.target.select()}
              />
            </label>
          )}
          {repository?.operation?.error && <p role="alert">{repository.operation.error}</p>}
          <div className="ph-actions">
            {repository?.source?.location && (
              <button
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await api(base + '/repository/fetch', {});
                  })
                }
              >
                Fetch upstream
              </button>
            )}
            {repository?.operation &&
              ['failed', 'unknown', 'cancelled'].includes(repository.operation.status) && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await api(base + '/repository/retry', {});
                    })
                  }
                >
                  Retry setup
                </button>
              )}
          </div>
          {file ? (
            <>
              <button onClick={() => setFile(null)}>Back to files</button>
              <h3>{file.path}</h3>
              <pre>{file.content || file.omitted}</pre>
            </>
          ) : (
            <div className="ph-files">
              {folder && (
                <button
                  onClick={() => {
                    folderRef.current = '';
                    setFolder('');
                    void refresh();
                  }}
                >
                  Back to repository root
                </button>
              )}
              {tree.map((entry) => (
                <button
                  key={entry.path}
                  onClick={() =>
                    void action(async () => {
                      if (entry.type === 'tree') {
                        folderRef.current = entry.path;
                        setFolder(entry.path);
                        setTree(
                          (
                            await api(
                              base + '/repository/tree?path=' + encodeURIComponent(entry.path),
                            )
                          ).entries,
                        );
                      } else
                        setFile(
                          await api(
                            base + '/repository/blob?path=' + encodeURIComponent(entry.path),
                          ),
                        );
                    })
                  }
                >
                  <WorkspaceIcon name={entry.type === 'tree' ? 'folder' : 'file'} />
                  {entry.path}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className={`ph-layout ${selected || creating ? 'has-detail' : ''}`}>
          <div className="ph-list">
            <div className="ph-list-toolbar">
              <span className="pw-muted">
                {items.length}{' '}
                {tab === 'pulls' ? 'pull requests' : tab === 'pipelines' ? 'runs' : 'issues'}
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
                    branches.find((b: string) => b !== (repository?.defaultBranch || 'main')) || '',
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
                    {item.status} · {new Date(item.createdAt).toLocaleDateString()}
                  </small>
                </span>
              </button>
            ))}
          </div>
          {(selected || creating) && (
            <div className="ph-detail">
              <button
                className="ph-back"
                onClick={() => {
                  setSelected('');
                  setCreating(false);
                }}
              >
                Back to list
              </button>
              {creating ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void action(async () => {
                      const result = await api(
                        editing ? base + '/' + tab + '/' + selected + '/update' : base + '/' + tab,
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
                      <select value={branch} onChange={(e) => setBranch(e.target.value)}>
                        <option value="HEAD">Default branch</option>
                        {branches.map((b: string) => (
                          <option key={b}>{b}</option>
                        ))}
                      </select>
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
                        <textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
                      </label>
                    </>
                  )}
                  {tab === 'pulls' && !editing && (
                    <div className="ph-branches">
                      <label>
                        Source
                        <select required value={source} onChange={(e) => setSource(e.target.value)}>
                          <option value="">Choose branch</option>
                          {branches.map((b: string) => (
                            <option key={b}>{b}</option>
                          ))}
                        </select>
                      </label>
                      <WorkspaceIcon name="arrow-right" />
                      <label>
                        Target
                        <select value={target} onChange={(e) => setTarget(e.target.value)}>
                          {branches.map((b: string) => (
                            <option key={b}>{b}</option>
                          ))}
                        </select>
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
                        {detail.pipeline.deployment.status}
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
                      {tab === 'pulls' && row.status === 'open' && comparison && (
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
                        {row.taskIds.map((taskId: string, index: number) => (
                          <button key={taskId} onClick={() => openTask(taskId)}>
                            Open task {index + 1}
                          </button>
                        ))}
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
    </dialog>
  );
}
