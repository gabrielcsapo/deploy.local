'use client';
import { RepositoryClone } from './repository-clone.client';
import { Skeleton } from '@/components/ui';
import { IconLink } from '@/components/ui';

import { IconButton, CopyButton } from '@/components/ui';
import { Button, Select, TextField, WorkspaceIcon } from '@/components/ui';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { repositoryLanguage, repositoryLink, relativeCommitTime } from './repository-presentation';
import { parseTaskDiff } from './task-diff';
import { useRouter } from 'react-flight-router/client';
import './repository-workbench.css';
type Row = Record<string, any>;
type Location = { path: string; type: 'tree' | 'blob' };
type Mode = 'files' | 'history' | 'commit';
const memory = new Map<
  string,
  {
    source: string;
    location: Location;
    mode: Mode;
    commit: string;
    preview: boolean;
    positions: Record<string, { top: number; left: number }>;
  }
>();
export function RepositoryWorkbench({
  project,
  tasks,
  repository,
  api,
  branch: selectedBranch,
  setBranch,
  startTask,
  refreshRepository,
}: {
  project: Row;
  tasks: Row[];
  repository: Row | null;
  api: (path: string, body?: Row) => Promise<any>;
  branch: string;
  setBranch: (branch: string) => void;
  startTask: (ref: string, path?: string) => void;
  refreshRepository: () => Promise<void>;
}) {
  const { url } = useRouter();
  const initial = useRef(new URL(url, 'http://localhost').searchParams).current;
  const saved = useRef(memory.get(project.id)).current;
  const [branch, setSource] = useState(
    initial.get('task') ? `task:${initial.get('task')}` : saved?.source || selectedBranch,
  );
  const [location, setLocation] = useState<Location>(
    initial.get('path')
      ? { path: initial.get('path')!, type: 'blob' }
      : saved?.location || { path: '', type: 'tree' },
  );
  const [mode, setMode] = useState<Mode>(initial.get('task') ? 'files' : saved?.mode || 'files');
  const [commit, setCommit] = useState(saved?.commit || '');
  const [preview, setPreview] = useState(saved?.preview ?? true);
  const [data, setData] = useState<Row | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [dialog, setDialog] = useState<'find' | 'clone' | null>(null);
  const [query, setQuery] = useState('');
  const [paths, setPaths] = useState<string[] | null>(null);
  const [pathsError, setPathsError] = useState('');
  const [pathsTruncated, setPathsTruncated] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [fetching, setFetching] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const modal = useRef<HTMLDialogElement>(null);
  const finder = useRef<HTMLButtonElement>(null);
  const clone = useRef<HTMLButtonElement>(null);
  const navigation = useRef(0);
  const positions = useRef(
    saved?.positions || ({} as Record<string, { top: number; left: number }>),
  );
  const stateKey = `${branch}:${mode}:${location.type}:${location.path}:${commit}:${preview}`;
  const base = `/projects/${project.id}/repository`;
  const requestKey = `${branch}:${mode}:${location.type}:${location.path}:${commit}`;
  const branches: Row[] = (repository?.refs || []).filter((ref: Row) =>
    ref.name.startsWith('refs/heads/'),
  );
  const tags = (repository?.refs || []).filter((ref: Row) => ref.name.startsWith('refs/tags/'));
  const branchName = branch === 'HEAD' ? repository?.defaultBranch || 'HEAD' : branch;
  const revision =
    branches.find((ref: Row) => ref.name === `refs/heads/${branchName}`)?.oid || repository?.head;
  const taskId = branch.startsWith('task:') ? branch.slice(5) : '';
  const task = tasks.find((item) => item.id === taskId);
  const taskBase = `/tasks/${encodeURIComponent(taskId)}/files`;
  const ready = Boolean(taskId) || repository?.status === 'ready';
  const resourceLoading = loading || (!error && data?.key !== requestKey);
  const capture = useCallback(() => {
    if (!loading && data?.key === requestKey && scroller.current)
      positions.current[stateKey] = {
        top: scroller.current.scrollTop,
        left: scroller.current.scrollLeft,
      };
  }, [stateKey, loading, data, requestKey]);
  useEffect(() => {
    memory.set(project.id, {
      source: branch,
      location,
      mode,
      commit,
      preview,
      positions: positions.current,
    });
  }, [project.id, branch, location, mode, commit, preview]);
  useLayoutEffect(() => {
    if (loading || data?.key !== requestKey || !scroller.current) return;
    const position = positions.current[stateKey];
    scroller.current.scrollTop = position?.top || 0;
    scroller.current.scrollLeft = position?.left || 0;
  }, [stateKey, requestKey, loading, data]);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    setLoading(true);
    setFeedback('');
    setError('');
    setData(null);
    const ref = mode === 'commit' ? commit : revision || branch;
    const params = `?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(location.path)}`;
    void (async () => {
      try {
        const history = taskId
          ? Promise.resolve({ commits: [] })
          : api(base + '/history' + params + '&limit=' + (mode === 'history' ? 30 : 1));
        const resource = taskId
          ? api(
              taskBase +
                (location.type === 'blob' ? '/content' : '') +
                '?path=' +
                encodeURIComponent(location.path),
            )
          : mode === 'commit'
            ? api(base + '/diff' + params)
            : mode === 'history'
              ? Promise.resolve(null)
              : api(base + (location.type === 'tree' ? '/tree' : '/blob') + params);
        const [log, content] = await Promise.all([history, resource]);
        let readme = null,
          readmeError = '';
        const entry = content?.entries?.find(
          (item: Row) =>
            item.type === 'blob' && /^readme(?:\.md|\.markdown|\.txt)?$/i.test(item.name),
        );
        if (entry) {
          try {
            readme = await api(
              taskId
                ? taskBase + '/content?path=' + encodeURIComponent(entry.path)
                : base +
                    '/blob?ref=' +
                    encodeURIComponent(content.commit) +
                    '&path=' +
                    encodeURIComponent(entry.path),
            );
          } catch (failure: any) {
            readmeError = failure.message;
          }
        }
        if (active)
          setData({ key: requestKey, content, history: log.commits, readme, readmeError });
      } catch (failure: any) {
        if (active) setError(failure.message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [
    api,
    base,
    branch,
    revision,
    ready,
    location.path,
    location.type,
    mode,
    commit,
    retry,
    requestKey,
    taskId,
    taskBase,
  ]);
  useEffect(() => {
    setPaths(null);
    setPathsError('');
  }, [branch, revision]);
  useEffect(() => {
    if (!dialog) return;
    const element = modal.current;
    const trigger = (dialog === 'find' ? finder : clone).current;
    element?.showModal();
    if (dialog === 'find') element?.querySelector<HTMLInputElement>('input')?.focus();
    return () => {
      element?.close();
      trigger?.focus({ preventScroll: true });
    };
  }, [dialog]);
  useEffect(() => {
    if (dialog !== 'find' || paths) return;
    let active = true;
    void api(base + '/files?ref=' + encodeURIComponent(revision || branch))
      .then((result) => {
        if (active) {
          setPaths(result.paths);
          setPathsTruncated(result.truncated);
        }
      })
      .catch((failure) => {
        if (active) setPathsError(failure.message);
      });
    return () => {
      active = false;
    };
  }, [dialog, api, base, branch, revision, paths, retry]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== 't' ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.defaultPrevented ||
        document.querySelector('dialog[open]')
      )
        return;
      const target = event.target as HTMLElement;
      if (target.closest('input,textarea,select,[contenteditable="true"]') || !ready || taskId)
        return;
      event.preventDefault();
      setDialog('find');
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [ready, taskId]);
  const go = useCallback(
    async (path: string, type?: 'tree' | 'blob') => {
      const ticket = ++navigation.current;
      capture();
      setError('');
      try {
        const entry = type
          ? { type }
          : taskId
            ? {
                type: !path
                  ? 'tree'
                  : (
                      await api(
                        taskBase +
                          '?path=' +
                          encodeURIComponent(path.split('/').slice(0, -1).join('/')),
                      )
                    ).entries.find((entry: Row) => entry.path === path)?.type || 'blob',
              }
            : await api(
                base +
                  '/entry?ref=' +
                  encodeURIComponent(revision || branch) +
                  '&path=' +
                  encodeURIComponent(path),
              );
        if (ticket !== navigation.current) return;
        setLocation({ path, type: entry.type });
        setMode('files');
        setCommit('');
        setPreview(true);
        setDialog(null);
      } catch (failure: any) {
        if (ticket === navigation.current) setError(failure.message);
      }
    },
    [api, base, revision, branch, capture, taskId, taskBase],
  );
  const showHistory = () => {
    capture();
    setMode('history');
    setCommit('');
  };
  const showCommit = (oid: string) => {
    capture();
    setCommit(oid);
    setMode('commit');
  };
  const file =
    data?.key === requestKey && location.type === 'blob' && mode === 'files' ? data.content : null;
  const blobURL = useMemo(() => {
    if (!file || (file.omitted && !file.image)) return null;
    const bytes = file.image
      ? Uint8Array.from(atob(file.image.data), (char) => char.charCodeAt(0))
      : String(file.content || '');
    return URL.createObjectURL(
      new Blob([bytes], { type: file.image?.mimeType || 'text/plain;charset=utf-8' }),
    );
  }, [file]);
  useEffect(
    () => () => {
      if (blobURL) URL.revokeObjectURL(blobURL);
    },
    [blobURL],
  );
  const markdown = (text: string, path: string) => (
    <RepositoryMarkdown text={text} path={path} navigate={go} />
  );
  const latest = data?.history?.[0];
  const entries: Row[] = [...(data?.content?.entries || [])].sort(
    (a, b) => Number(b.type === 'tree') - Number(a.type === 'tree') || a.name.localeCompare(b.name),
  );
  const results = (paths || [])
    .filter((path) => path.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 100);
  return (
    <section className="rb-workbench" aria-label={`${project.name} files`}>
      <div className="rb-location">
        <div className="rb-header-actions">
          <Button
            ref={clone}
            variant="secondary"
            disabled={!ready}
            onClick={() => {
              setFeedback('');
              setDialog('clone');
            }}
          >
            Clone
          </Button>
          <Button
            variant="primary"
            disabled={!ready}
            onClick={() =>
              startTask(
                taskId
                  ? task?.baseRevision || 'HEAD'
                  : mode === 'commit'
                    ? commit
                    : revision || branch,
                location.path,
              )
            }
          >
            <WorkspaceIcon name="compose" /> New task
          </Button>
        </div>
      </div>
      <div className="rb-controls">
        <Select
          aria-label="Source: branch or task"
          value={branch}
          disabled={!ready && !tasks.some((item) => item.workspacePath)}
          onChange={(event) => {
            navigation.current++;
            capture();
            setSource(event.target.value);
            if (!event.target.value.startsWith('task:')) setBranch(event.target.value);
            setLocation({ path: '', type: 'tree' });
            setMode('files');
            setCommit('');
          }}
        >
          <option value="HEAD">{repository?.defaultBranch || 'Default branch'}</option>
          {tasks
            .filter((item) => item.workspacePath)
            .map((item) => (
              <option key={item.id} value={`task:${item.id}`}>
                Task: {item.title} · {item.status}
              </option>
            ))}
          {branches
            .filter((ref) => ref.name.slice(11) !== repository?.defaultBranch)
            .map((ref) => (
              <option key={ref.name} value={ref.name.slice(11)}>
                {ref.name.slice(11)}
              </option>
            ))}
        </Select>
        <IconButton
          icon="refresh"
          label="Refresh files"
          disabled={!ready || loading}
          onClick={() => setRetry((value) => value + 1)}
        />
        <span className="rb-ref-count" hidden={!ready}>
          {branches.length} {branches.length === 1 ? 'branch' : 'branches'}
          {tags.length ? ` · ${tags.length} ${tags.length === 1 ? 'tag' : 'tags'}` : ''}
        </span>
        <Button variant="link" disabled={!ready || Boolean(taskId)} onClick={showHistory}>
          History
        </Button>
        <Button
          variant="link"
          ref={finder}
          className="rb-find"
          disabled={!ready || Boolean(taskId)}
          onClick={() => {
            setQuery('');
            setDialog('find');
          }}
        >
          <WorkspaceIcon name="search" /> Go to file <kbd>T</kbd>
        </Button>
      </div>
      {(location.path || mode !== 'files') && (
        <nav className="rb-breadcrumbs" aria-label="Repository path">
          <Button variant="link" onClick={() => void go('', 'tree')}>
            Repository root
          </Button>
          {location.path
            .split('/')
            .filter(Boolean)
            .map((part, index, parts) => (
              <span key={index}>
                <span aria-hidden="true">/</span>
                <Button
                  variant="link"
                  onClick={() =>
                    void go(
                      parts.slice(0, index + 1).join('/'),
                      index === parts.length - 1 ? location.type : 'tree',
                    )
                  }
                >
                  {part}
                </Button>
              </span>
            ))}
          {mode !== 'files' && (
            <span className="rb-current-section">
              {mode === 'history' ? 'History' : commit.slice(0, 7)}
            </span>
          )}
        </nav>
      )}
      <div
        ref={scroller}
        className="rb-scroll"
        tabIndex={0}
        aria-label={
          mode === 'history'
            ? 'Commit history'
            : mode === 'commit'
              ? 'Commit changes'
              : file
                ? `Source ${location.path}`
                : 'Repository contents'
        }
        aria-busy={ready && resourceLoading}
        onScroll={capture}
      >
        {((!repository && !taskId) || (ready && data?.key !== requestKey)) && !error ? (
          <Skeleton variant="detail" label="Loading repository" />
        ) : !ready && repository ? (
          <p className="ds-feedback" role="status">
            Repository {repository.status}
          </p>
        ) : null}
        {(error || (!taskId && repository?.operation?.error)) && (
          <div className="rb-feedback" role="alert">
            <span>{error || repository?.operation?.error}</span>
            <IconButton
              icon="refresh"
              label="Retry"
              onClick={() => {
                setRetry((value) => value + 1);
                if (!taskId) void refreshRepository();
              }}
            />
          </div>
        )}
        {!ready && ['failed', 'unknown', 'cancelled'].includes(repository?.operation?.status) && (
          <Button
            variant="link"
            onClick={() =>
              void api(base + '/retry', {})
                .then(refreshRepository)
                .catch((failure) => setError(failure.message))
            }
          >
            Retry setup
          </Button>
        )}
        {data?.key === requestKey && (
          <>
            {mode === 'history' ? (
              <div className="rb-history" data-resource-list>
                {data.history.length ? (
                  data.history.map((item: Row) => (
                    <button
                      key={item.oid}
                      className="rb-history-row"
                      onClick={() => showCommit(item.oid)}
                    >
                      <WorkspaceIcon name="circle" />
                      <span>
                        <strong>{item.subject}</strong>
                        <small>
                          {item.author} ·{' '}
                          <time dateTime={item.date} title={new Date(item.date).toLocaleString()}>
                            {relativeCommitTime(item.date)}
                          </time>
                        </small>
                      </span>
                      <code>{item.oid.slice(0, 7)}</code>
                      <WorkspaceIcon name="chevron" />
                    </button>
                  ))
                ) : (
                  <p className="ds-feedback">No commits for this path.</p>
                )}
                <p className="rb-meta">
                  Showing the latest {data.history.length} commits
                  {location.path ? ` for ${location.path}` : ''}.
                </p>
              </div>
            ) : (
              <>
                {latest && (
                  <div className="rb-latest">
                    <WorkspaceIcon name="circle" />
                    <div>
                      <button onClick={() => showCommit(latest.oid)}>{latest.subject}</button>
                      <small>
                        {latest.author} ·{' '}
                        <time dateTime={latest.date} title={new Date(latest.date).toLocaleString()}>
                          {relativeCommitTime(latest.date)}
                        </time>
                      </small>
                    </div>
                    <Button variant="link" onClick={() => showCommit(latest.oid)}>
                      <code>{latest.oid.slice(0, 7)}</code>
                    </Button>
                  </div>
                )}
                {mode === 'commit' ? (
                  <RepositoryCommit patch={data.content?.patch || ''} />
                ) : file ? (
                  <section className="rb-file">
                    <header className="rb-file-heading">
                      <strong>
                        {file.change ? `${file.change} · ` : ''}
                        {location.path.split('/').pop()}
                      </strong>
                      <span className="rb-meta">{file.size?.toLocaleString()} B</span>
                      <div className="rb-file-actions">
                        {/\.(md|markdown)$/i.test(location.path) && (
                          <Button
                            variant="link"
                            onClick={() => {
                              capture();
                              setPreview((value) => !value);
                            }}
                          >
                            {preview ? 'Source' : 'Preview'}
                          </Button>
                        )}
                        <Button variant="link" disabled={Boolean(taskId)} onClick={showHistory}>
                          History
                        </Button>
                        {!file.omitted && (
                          <CopyButton size="compact" label="Copy file" text={file.content} />
                        )}
                        {blobURL && (
                          <>
                            <IconLink
                              icon="external"
                              label="Open raw file"
                              href={blobURL}
                              target="_blank"
                              rel="noopener noreferrer"
                            />
                            <IconLink
                              icon="download"
                              label="Download file"
                              href={blobURL}
                              download={location.path.split('/').pop()}
                            />
                          </>
                        )}
                      </div>
                    </header>
                    {file.image ? (
                      <div className="rb-image">
                        <img
                          src={`data:${file.image.mimeType};base64,${file.image.data}`}
                          alt={location.path}
                        />
                      </div>
                    ) : file.omitted ? (
                      <p className="ds-feedback">{file.omitted}</p>
                    ) : /\.(md|markdown)$/i.test(location.path) && preview ? (
                      markdown(file.content, location.path)
                    ) : (
                      <RepositorySource text={file.content} path={location.path} />
                    )}
                  </section>
                ) : (
                  <>
                    <div className="rb-file-group">
                      <table className="rb-files" data-resource-list>
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>Last commit</th>
                            <th>Updated</th>
                            <th>Size</th>
                          </tr>
                        </thead>
                        <tbody>
                          {entries.map((entry) => (
                            <tr key={entry.path}>
                              <td>
                                <button onClick={() => void go(entry.path, entry.type)}>
                                  <WorkspaceIcon name={entry.type === 'tree' ? 'folder' : 'file'} />
                                  <span>
                                    {entry.name}
                                    {entry.change ? ` · ${entry.change}` : ''}
                                  </span>
                                </button>
                              </td>
                              <td>
                                {entry.lastCommit ? (
                                  <button
                                    className="rb-commit-link"
                                    title={entry.lastCommit.subject}
                                    onClick={() => showCommit(entry.lastCommit.revision)}
                                  >
                                    {entry.lastCommit.subject}
                                  </button>
                                ) : (
                                  '—'
                                )}
                              </td>
                              <td>
                                {entry.lastCommit?.date ? (
                                  <time
                                    dateTime={entry.lastCommit.date}
                                    title={new Date(entry.lastCommit.date).toLocaleString()}
                                  >
                                    {relativeCommitTime(entry.lastCommit.date)}
                                  </time>
                                ) : (
                                  '—'
                                )}
                              </td>
                              <td>
                                {entry.size == null ? '—' : entry.size.toLocaleString() + ' B'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!entries.length && (
                        <p className="ds-feedback">
                          {data.content?.omitted || 'This folder is empty.'}
                        </p>
                      )}
                    </div>
                    {data.readme && (
                      <section className="rb-readme" aria-label="Repository README">
                        <header>
                          <WorkspaceIcon name="file" />
                          <button onClick={() => void go(data.readme.path, 'blob')}>
                            {data.readme.path.split('/').pop()}
                          </button>
                        </header>
                        {data.readme.omitted ? (
                          <p className="ds-feedback">{data.readme.omitted}</p>
                        ) : (
                          markdown(data.readme.content, data.readme.path)
                        )}
                      </section>
                    )}
                    {data.readmeError && (
                      <div className="rb-feedback" role="alert">
                        <span>README unavailable. {data.readmeError}</span>
                        <IconButton
                          icon="refresh"
                          label="Retry README"
                          onClick={() => setRetry((value) => value + 1)}
                        />
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
      <footer className="rb-status">
        <span>
          {feedback ||
            (data?.key === requestKey && !resourceLoading
              ? mode === 'history'
                ? 'History'
                : mode === 'commit'
                  ? `Commit ${commit.slice(0, 7)}`
                  : file
                    ? `${file.size?.toLocaleString()} B`
                    : `${entries.length} items`
              : '')}
        </span>
        <code title={revision}>{revision?.slice(0, 7)}</code>
      </footer>
      {dialog && (
        <dialog
          ref={modal}
          className="rb-dialog ds-motion-enter"
          aria-label={dialog === 'find' ? 'Go to file' : 'Clone repository'}
          onCancel={() => setDialog(null)}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              const box = event.currentTarget.getBoundingClientRect();
              if (
                event.clientX < box.left ||
                event.clientX > box.right ||
                event.clientY < box.top ||
                event.clientY > box.bottom
              )
                setDialog(null);
            }
          }}
        >
          <header>
            <strong>{dialog === 'find' ? 'Go to file' : 'Clone repository'}</strong>
            <IconButton
              icon="close"
              label="Close repository dialog"
              onClick={() => setDialog(null)}
            />
          </header>
          {dialog === 'find' ? (
            <>
              <TextField
                label="Find repository file"
                appearance="plain"
                autoFocus
                type="search"
                placeholder="Find a file…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && results[0]) {
                    event.preventDefault();
                    void go(results[0], 'blob');
                  }
                }}
              />
              <div className="rb-finder-results" data-resource-list>
                {pathsError ? (
                  <div className="rb-feedback" role="alert">
                    {pathsError}
                    <IconButton
                      icon="refresh"
                      label="Retry"
                      onClick={() => {
                        setPathsError('');
                        setRetry((value) => value + 1);
                      }}
                    />
                  </div>
                ) : !paths ? (
                  <p className="ds-feedback" role="status">
                    Loading files…
                  </p>
                ) : results.length ? (
                  results.map((path) => (
                    <button key={path} onClick={() => void go(path, 'blob')}>
                      <WorkspaceIcon name="file" />
                      <span>{path}</span>
                    </button>
                  ))
                ) : (
                  <p className="ds-feedback" role="status">
                    No matching files.
                  </p>
                )}
              </div>
              <footer>
                {pathsTruncated ? 'First 10,000 files indexed.' : `${paths?.length || 0} files`}
                {results.length === 100 ? ' · Showing first 100 matches' : ''}
              </footer>
            </>
          ) : (
            <div className="rb-clone-content">
              <RepositoryClone repository={repository || {}} />
              {repository?.source?.location && (
                <Button
                  variant="link"
                  disabled={fetching}
                  onClick={async () => {
                    setFetching(true);
                    try {
                      await api(base + '/fetch', {});
                      await refreshRepository();
                      setFeedback('Fetch queued');
                    } catch (failure: any) {
                      setFeedback(failure.message);
                    } finally {
                      setFetching(false);
                    }
                  }}
                >
                  Fetch import source
                </Button>
              )}
              <p role="status" className="rb-meta">
                {feedback}
              </p>
            </div>
          )}
        </dialog>
      )}
    </section>
  );
}
const RepositorySource = memo(function RepositorySource({
  text,
  path,
}: {
  text: string;
  path: string;
}) {
  const source = String(text || '');
  const fence = '~'.repeat(
    Math.max(3, ...(source.match(/~+/g) || []).map((value) => value.length + 1)),
  );
  return (
    <div className="rb-source">
      <pre className="rb-line-numbers" aria-hidden="true">
        {source
          .split('\n')
          .map((_, index) => index + 1)
          .join('\n')}
      </pre>
      <Markdown
        rehypePlugins={[[rehypeHighlight, { detect: false }]]}
        skipHtml
      >{`${fence}${repositoryLanguage(path)}\n${source}\n${fence}`}</Markdown>
    </div>
  );
});
const RepositoryMarkdown = memo(function RepositoryMarkdown({
  text,
  path,
  navigate,
}: {
  text: string;
  path: string;
  navigate: (path: string) => Promise<void>;
}) {
  const heading = (level: number, children: ReactNode) => {
    const headingText = (value: ReactNode): string =>
      Array.isArray(value)
        ? value.map(headingText).join('')
        : typeof value === 'string' || typeof value === 'number'
          ? String(value)
          : value && typeof value === 'object' && 'props' in value
            ? headingText((value.props as { children: ReactNode }).children)
            : '';
    const id = headingText(children)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s+/g, '-');
    const tag = `h${level}` as 'h1';
    const Heading = tag;
    return <Heading id={id}>{children}</Heading>;
  };
  return (
    <div className="rb-markdown pw-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false }]]}
        skipHtml
        components={{
          h1: ({ children }) => heading(1, children),
          h2: ({ children }) => heading(2, children),
          h3: ({ children }) => heading(3, children),
          a: ({ href, children }) => {
            const destination = repositoryLink(href || '', path);
            return (
              <a
                href={href}
                target={destination || href?.startsWith('#') ? undefined : '_blank'}
                rel="noopener noreferrer"
                onClick={
                  destination
                    ? (event) => {
                        event.preventDefault();
                        void navigate(destination.path);
                      }
                    : undefined
                }
              >
                {children}
              </a>
            );
          },
          img: ({ alt }) => (
            <span className="rb-meta">
              {alt ? `Image: ${alt}` : 'Image'} · Open the source image from Files.
            </span>
          ),
          pre: ({ children }) => (
            <pre tabIndex={0} aria-label="README code">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="rb-markdown-table" tabIndex={0} role="region" aria-label="README table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
});
function RepositoryCommit({ patch }: { patch: string }) {
  const files = useMemo(() => parseTaskDiff(patch), [patch]);
  return (
    <div className="rb-commit">
      {files.length ? (
        files.map((file) => (
          <section className="rb-diff" key={file.path} aria-label={`Diff for ${file.path}`}>
            <header>
              <WorkspaceIcon name="file" />
              {file.path}
            </header>
            <div tabIndex={0} role="region" aria-label={`Changes in ${file.path}`}>
              <pre>
                {file.lines.map((line, index) => (
                  <span className={`rb-diff-line ${line.kind}`} key={index}>
                    <span>{line.oldLine ?? ''}</span>
                    <span>{line.newLine ?? ''}</span>
                    <code>{line.text || ' '}</code>
                  </span>
                ))}
              </pre>
            </div>
          </section>
        ))
      ) : (
        <p className="ds-feedback">No text changes for this commit and path.</p>
      )}
    </div>
  );
}
