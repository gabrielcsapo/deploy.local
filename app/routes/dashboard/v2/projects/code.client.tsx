'use client';
import { useProjectFormatting } from './formatting.ts';
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { useSearchParams } from 'react-flight-router/client';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import {
  Action,
  Banner,
  Dialog,
  Field,
  Group,
  Icon,
  IconButton,
  Item,
  Skeleton,
} from '@/components/ui';
import { request, useData, useBrowserOrigin, type Overview } from './data';
import { projectPath, projectSegment } from './routing';
import { fileSize, sourceLines, sourceMarkdown, type RepositoryCommit } from './code';
import './code.css';

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      className="dl-icon-btn sm"
      aria-label={copied ? 'Copied' : failed ? 'Copy failed. Try again.' : label}
      title={copied ? 'Copied' : failed ? 'Copy failed. Try again.' : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setFailed(false);
        } catch {
          setFailed(true);
        }
      }}
    >
      {copied ? (
        <Icon name="check" size={14} />
      ) : (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          aria-hidden="true"
        >
          <rect x="9" y="9" width="12" height="12" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
      )}
    </button>
  );
}
export function ProjectCode({ overview }: { overview: Overview }) {
  const { repositoryTime, formatCount } = useProjectFormatting();
  const origin = useBrowserOrigin();
  const [params, setParams] = useSearchParams();
  const path = params.get('path') || '';
  const file = params.get('file') || '';
  const ref = params.get('ref') || overview.repository?.defaultBranch || 'HEAD';
  const history = params.has('history');
  const [filter, setFilter] = useState('');
  const [picker, setPicker] = useState<'branches' | 'tags' | null>(null);
  const [clone, setClone] = useState(false);
  const cloneMenu = useId();
  const [clonePosition, setClonePosition] = useState({ top: 0, right: 0 });
  const [outline, setOutline] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const readmeElement = useRef<HTMLDivElement>(null);
  const base = `/api/workspace/projects/${encodeURIComponent(overview.project.id)}/repository`;
  const page = `${projectPath(overview.project.id)}/code`;
  const href = (next: { path?: string; file?: string; ref?: string; history?: boolean } = {}) => {
    const query = new URLSearchParams({ ref: next.ref || ref });
    if (next.path) query.set('path', next.path);
    if (next.file) query.set('file', next.file);
    if (next.history) query.set('history', 'true');
    return `${page}?${query}`;
  };
  const query = `ref=${encodeURIComponent(ref)}`;
  const info = useData<{ refs?: { name: string; oid: string }[] }>(base);
  const tree = useData<{
    commit: string;
    commitCount: number;
    latestCommit: RepositoryCommit | null;
    entries: {
      name: string;
      path: string;
      type: string;
      lastCommit?: { subject: string; date: string };
    }[];
  }>(!file ? `${base}/tree?${query}&path=${encodeURIComponent(path)}` : undefined);
  const blob = useData<{
    commit: string;
    size: number;
    content?: string;
    omitted?: string;
    latestCommit: RepositoryCommit | null;
  }>(file ? `${base}/blob?${query}&path=${encodeURIComponent(file)}` : undefined);
  const pinned = file ? blob.data?.commit : tree.data?.commit;
  const readmePath = tree.data?.entries.find((entry) =>
    /^readme(?:\.md|\.markdown)?$/i.test(entry.name),
  )?.path;
  const readme = useData<{ content?: string }>(
    !file && readmePath && pinned
      ? `${base}/blob?ref=${pinned}&path=${encodeURIComponent(readmePath)}`
      : undefined,
  );
  const finder = useData<{ paths: string[]; truncated: boolean }>(
    filter && pinned ? `${base}/files?ref=${pinned}` : undefined,
  );
  const commits = useData<{ commits: RepositoryCommit[] }>(
    history && pinned
      ? `${base}/history?ref=${pinned}&path=${encodeURIComponent(file || path)}&limit=100`
      : undefined,
  );
  const branches = info.data?.refs?.filter((entry) => entry.name.startsWith('refs/heads/'));
  const tags = info.data?.refs?.filter((entry) => entry.name.startsWith('refs/tags/'));
  const latest = file ? blob.data?.latestCommit : tree.data?.latestCommit;
  const lines = sourceLines(blob.data?.content ?? '');
  const [raw, setRaw] = useState('');
  useEffect(() => {
    if (blob.data?.content === undefined) {
      setRaw('');
      return;
    }
    const url = URL.createObjectURL(
      new Blob([blob.data.content], { type: 'text/plain;charset=utf-8' }),
    );
    setRaw(url);
    return () => URL.revokeObjectURL(url);
  }, [blob.data]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== 't' ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (event.target as HTMLElement)?.closest('input, textarea, [contenteditable="true"]')
      )
        return;
      event.preventDefault();
      search.current?.focus();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const historyHref = href({ path, file, history: true });
  return (
    <>
      <div className="v2-repo-bar">
        <Action onClick={() => setPicker('branches')}>
          <Icon name="branch" size={14} />
          {ref.replace(/^refs\/(heads|tags)\//, '')}
          <Icon name="down" size={12} />
        </Action>
        {file || path ? (
          <nav className="v2-code-crumb" aria-label="Path">
            <a className="dl-link" href={href()}>
              {overview.project.name}
            </a>
            {(file || path).split('/').map((part, index, parts) => (
              <Fragment key={index}>
                <span className="dl-muted">/</span>
                {index === parts.length - 1 ? (
                  <span className="dl-strong">{part}</span>
                ) : (
                  <a className="dl-link" href={href({ path: parts.slice(0, index + 1).join('/') })}>
                    {part}
                  </a>
                )}
              </Fragment>
            ))}
            <CopyButton value={file || path} label="Copy path" />
          </nav>
        ) : (
          <>
            <button className="v2-repo-count" onClick={() => setPicker('branches')}>
              <Icon name="branch" size={14} />
              <b>{branches?.length ?? '—'}</b> branches
            </button>
            <button className="v2-repo-count" onClick={() => setPicker('tags')}>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                aria-hidden="true"
              >
                <path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z" />
                <circle cx="7.5" cy="7.5" r="1.5" />
              </svg>
              <b>{tags?.length ?? '—'}</b> tags
            </button>
          </>
        )}
        <span className={`v2-repo-end${file ? ' dl-hide-mid' : ''}`}>
          <label className="dl-field v2-code-search">
            <span className="dl-sr">Go to file</span>
            <Icon name="search" size={14} />
            <input
              ref={search}
              placeholder="Go to file"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <span className="dl-kbd">T</span>
          </label>
          {!file && (
            <Action
              popoverTarget={cloneMenu}
              aria-expanded={clone}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setClonePosition({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
              }}
            >
              <Icon name="code" size={14} />
              Code
              <Icon name="down" size={12} />
            </Action>
          )}
        </span>
      </div>
      {filter && (
        <Group>
          {finder.error ? (
            <Banner title={finder.error} action={<Action onClick={finder.refresh}>Retry</Action>} />
          ) : !finder.data ? (
            <Skeleton rows={3} />
          ) : (
            <>
              {finder.data.paths
                .filter((name) => name.toLowerCase().includes(filter.toLowerCase()))
                .map((name) => (
                  <a
                    key={name}
                    className="dl-item"
                    href={href({ file: name })}
                    onClick={() => setFilter('')}
                  >
                    <Icon name="file" />
                    <span className="dl-t">{name}</span>
                  </a>
                ))}
              {finder.data.truncated && (
                <p className="dl-meta">File search is limited to the first 10,000 paths.</p>
              )}
            </>
          )}
        </Group>
      )}
      {(file ? blob.error : tree.error) && (
        <Banner
          title={file ? blob.error : tree.error}
          action={<Action onClick={file ? blob.refresh : tree.refresh}>Retry</Action>}
        />
      )}
      {!(file ? blob.data : tree.data) && !(file ? blob.error : tree.error) && (
        <Skeleton rows={7} />
      )}
      {(file ? blob.data : tree.data) && (
        <Group className={file ? 'v2-file-commit' : ''}>
          <div className="v2-commit-bar">
            <span className="dl-avatar v2-code-avatar">{latest?.author.slice(0, 1) || '?'}</span>
            <span className="dl-strong">{latest?.author || 'Unavailable'}</span>
            <a href={historyHref} className="v2-commit-message">
              {latest?.subject || 'Commit unavailable'}
            </a>
            <span className="v2-commit-end">
              <span className="dl-mono">{latest?.oid.slice(0, 7)}</span>
              <span>{repositoryTime(latest?.date)}</span>
              <a href={historyHref}>
                <Icon name="clock" size={14} />
                {file ? (
                  'History'
                ) : (
                  <>
                    <b>{tree.data && formatCount(tree.data.commitCount)}</b> commits
                  </>
                )}
              </a>
            </span>
          </div>
          {!file && (
            <div className="dl-table-wrap">
              <table className="dl-table v2-code-files">
                <colgroup>
                  <col className="v2-code-name-col" />
                  <col className="v2-code-message-col" />
                  <col className="v2-code-date-col" />
                </colgroup>
                <tbody>
                  {tree.data?.entries.map((entry) => (
                    <tr key={entry.path}>
                      <td className="dl-name">
                        <a
                          href={href(
                            entry.type === 'tree' ? { path: entry.path } : { file: entry.path },
                          )}
                        >
                          <Icon name={entry.type === 'tree' ? 'folder' : 'file'} />
                          <span>{entry.name}</span>
                        </a>
                      </td>
                      <td className="v2-code-message" title={entry.lastCommit?.subject}>
                        {entry.lastCommit?.subject || 'Unavailable'}
                      </td>
                      <td className="v2-code-date">{repositoryTime(entry.lastCommit?.date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Group>
      )}
      {file && blob.data && (
        <div className="dl-source">
          <div className="dl-source-head">
            <span className="dl-muted">
              {blob.data.content !== undefined ? `${lines.length} lines · ` : ''}
              {fileSize(blob.data.size)}
            </span>
            <span className="dl-end">
              {raw && (
                <>
                  <a className="dl-btn quiet" href={raw} target="_blank" rel="noreferrer">
                    Raw
                  </a>
                  <CopyButton value={blob.data.content!} label="Copy file" />
                  <a
                    className="dl-icon-btn sm"
                    href={raw}
                    download={file.split('/').at(-1)}
                    aria-label="Download"
                  >
                    <Icon name="download" size={14} />
                  </a>
                </>
              )}
            </span>
          </div>
          {blob.data.omitted ? (
            <p className="v2-code-omitted">{blob.data.omitted}</p>
          ) : (
            <div className="dl-lines v2-code-lines" role="region" aria-label={file} tabIndex={0}>
              <div className="v2-code-numbers" aria-hidden="true">
                {lines.map((_, index) => (
                  <span key={index}>{index + 1}</span>
                ))}
              </div>
              <Markdown rehypePlugins={[rehypeHighlight]}>
                {sourceMarkdown(file, blob.data.content || '')}
              </Markdown>
            </div>
          )}
        </div>
      )}
      {!file && readme.error && (
        <Banner
          title="README is unavailable"
          action={<Action onClick={readme.refresh}>Retry</Action>}
        />
      )}
      {!file && readme.data?.content !== undefined && (
        <Group>
          <div className="v2-readme-head">
            <Icon name="file" />
            README
            <span className="dl-end">
              <a className="dl-icon-btn" href={href({ file: readmePath })} aria-label="Open README">
                <Icon name="compose" />
              </a>
              <IconButton label="Outline" icon="menu" onClick={() => setOutline(true)} />
            </span>
          </div>
          <div className="v2-code-readme" ref={readmeElement}>
            <Markdown
              remarkPlugins={[remarkGfm]}
              urlTransform={(url, key) => {
                const link = defaultUrlTransform(url);
                return key === 'href' && link && !/^(?:[a-z]+:|\/\/|#)/i.test(link)
                  ? href({ file: [path, link].filter(Boolean).join('/') })
                  : link;
              }}
            >
              {readme.data.content}
            </Markdown>
          </div>
        </Group>
      )}
      <Dialog
        open={!!picker}
        onClose={() => setPicker(null)}
        title={picker === 'tags' ? 'Tags' : 'Branches'}
      >
        {info.error && (
          <Banner title={info.error} action={<Action onClick={info.refresh}>Retry</Action>} />
        )}
        {(picker === 'tags' ? tags : branches)?.map((entry) => (
          <a
            className="dl-item"
            key={entry.name}
            href={href({ ref: entry.name })}
            onClick={() => setPicker(null)}
          >
            {entry.name.replace(/^refs\/(heads|tags)\//, '')}
          </a>
        ))}
      </Dialog>
      <div
        id={cloneMenu}
        popover="auto"
        className="dl-menu v2-code-clone"
        style={clonePosition}
        aria-label="Clone repository"
        onToggle={(event) => setClone(event.newState === 'open')}
      >
        <div className="dl-menu-label">Clone</div>
        {clone && (
          <label className="dl-field">
            <input
              aria-label="Clone URL"
              readOnly
              value={
                new URL(overview.repository?.clonePath || base, origin || 'http://localhost').href
              }
            />
            <CopyButton
              label="Copy clone URL"
              value={
                new URL(overview.repository?.clonePath || base, origin || 'http://localhost').href
              }
            />
          </label>
        )}
      </div>
      <Dialog
        open={history}
        onClose={() => {
          const next = new URLSearchParams(params);
          next.delete('history');
          setParams(next);
        }}
        title="History"
      >
        {commits.error && (
          <Banner title={commits.error} action={<Action onClick={commits.refresh}>Retry</Action>} />
        )}
        {!commits.data && !commits.error && <Skeleton rows={4} />}
        {commits.data?.commits.map((commit) => (
          <Item
            key={commit.oid}
            title={commit.subject}
            description={`${commit.author} · ${repositoryTime(commit.date)}`}
            end={commit.oid.slice(0, 7)}
            href={href({ ref: commit.oid, ...(file ? { file } : { path }) })}
          />
        ))}
      </Dialog>
      <Dialog open={outline} onClose={() => setOutline(false)} title="Outline">
        {outline &&
          Array.from(readmeElement.current?.querySelectorAll('h1, h2, h3') || []).map(
            (heading, index) => (
              <Action
                key={index}
                variant="quiet"
                onClick={() => {
                  setOutline(false);
                  heading.scrollIntoView({ block: 'start' });
                }}
              >
                {heading.textContent}
              </Action>
            ),
          )}
      </Dialog>
    </>
  );
}
export function ProjectIssues({ overview, refresh }: { overview: Overview; refresh: () => void }) {
  const [closed, setClosed] = useState(false);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function create() {
    setBusy(true);
    setError('');
    try {
      await request(`/api/workspace/projects/${projectSegment(overview.project.id)}/issues`, {
        method: 'POST',
        body: JSON.stringify({ operationId: crypto.randomUUID(), title, body }),
      });
      setOpen(false);
      setTitle('');
      setBody('');
      refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="v2-project-toolbar">
        <Action variant={!closed ? 'secondary' : 'quiet'} onClick={() => setClosed(false)}>
          Open {overview.issues.filter((row) => row.state !== 'closed').length}
        </Action>
        <Action variant={closed ? 'secondary' : 'quiet'} onClick={() => setClosed(true)}>
          Closed {overview.issues.filter((row) => row.state === 'closed').length}
        </Action>
        <span className="dl-end" />
        <Action onClick={() => setOpen(true)}>New issue</Action>
      </div>
      <Group>
        {overview.issues
          .filter((row) => (row.state === 'closed') === closed)
          .map((row) => (
            <Item
              key={row.id}
              title={row.title}
              description={row.taskId ? 'Task running' : row.state}
              href={row.taskId ? `/dashboard/tasks/${encodeURIComponent(row.taskId)}` : undefined}
              lead={<Icon name="check" />}
            />
          ))}
      </Group>
      <Dialog
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        title="New issue"
        actions={
          <>
            <Action disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Action>
            <Action
              variant="primary"
              loading={busy}
              disabled={!title.trim()}
              onClick={() => void create()}
            >
              Create issue
            </Action>
          </>
        }
      >
        <div className="v2-project-form">
          <Field label="Title" value={title} onChange={(event) => setTitle(event.target.value)} />
          <Field
            label="Description"
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          {error && <Banner title={error} />}
        </div>
      </Dialog>
    </>
  );
}
