'use client';
import { useState } from 'react';
import Markdown from 'react-markdown';
import { Action, Banner, Dialog, Field, Group, Icon, Item, Skeleton } from '@/components/ui';
import { request, useData, type Overview } from './data';
import { projectSegment } from './routing';
export function ProjectCode({ overview }: { overview: Overview }) {
  const [path, setPath] = useState('');
  const [file, setFile] = useState('');
  const [filter, setFilter] = useState('');
  const [history, setHistory] = useState(false);
  const [copied, setCopied] = useState(false);
  const base = `/api/workspace/projects/${encodeURIComponent(overview.project.id)}/repository`;
  const tree = useData<{
    entries: {
      name: string;
      path: string;
      type: string;
      lastCommit?: { subject: string; date: string };
    }[];
  }>(`${base}/tree?path=${encodeURIComponent(path)}`);
  const blob = useData<{ content?: string; omitted?: string }>(
    file ? `${base}/blob?path=${encodeURIComponent(file)}` : undefined,
  );
  const readme = useData<{ content?: string }>(
    tree.data?.entries.some((entry) => entry.name === 'README.md')
      ? `${base}/blob?path=${encodeURIComponent([path, 'README.md'].filter(Boolean).join('/'))}`
      : undefined,
  );
  const commits = useData<{
    commits?: { oid?: string; revision?: string; subject: string; author?: string }[];
  }>(history ? `${base}/history` : undefined);
  return (
    <>
      <div className="v2-project-toolbar">
        <span className="dl-btn secondary">{overview.repository?.defaultBranch || 'HEAD'}</span>
        <Field
          label="Go to file"
          placeholder="Go to file"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <Action
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(
                new URL(overview.repository?.clonePath || base, window.location.origin).href,
              );
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? 'Copied' : 'Clone'}
        </Action>
        <Action onClick={() => setHistory(!history)}>History</Action>
      </div>
      {path && (
        <Action variant="quiet" onClick={() => setPath(path.split('/').slice(0, -1).join('/'))}>
          ← {path}
        </Action>
      )}
      {(tree.error || blob.error || commits.error) && (
        <Banner
          title={tree.error || blob.error || commits.error}
          action={<Action onClick={tree.refresh}>Retry</Action>}
        />
      )}
      {!tree.data && !tree.error && <Skeleton rows={7} />}
      <Group title={overview.repository?.head?.slice(0, 7)}>
        <div className="dl-table-wrap">
          <table className="dl-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Last commit</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {tree.data?.entries
                .filter((entry) => entry.name.includes(filter))
                .map((entry) => (
                  <tr key={entry.path}>
                    <td className="dl-name">
                      <button
                        className="v2-project-text-button v2-project-file"
                        onClick={() =>
                          entry.type === 'tree' ? setPath(entry.path) : setFile(entry.path)
                        }
                      >
                        <Icon name={entry.type === 'tree' ? 'folder' : 'file'} />
                        {entry.name}
                      </button>
                    </td>
                    <td>{entry.lastCommit?.subject || 'Unavailable'}</td>
                    <td>
                      {entry.lastCommit
                        ? new Date(entry.lastCommit.date).toLocaleDateString()
                        : 'Unavailable'}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Group>
      {readme.data?.content && (
        <Group title="README.md">
          <div className="v2-project-readme">
            <Markdown>{readme.data.content}</Markdown>
          </div>
        </Group>
      )}
      {history && (
        <Group title="History">
          {commits.data?.commits?.map((commit, index) => (
            <Item
              key={commit.oid || commit.revision || index}
              title={commit.subject}
              description={commit.author}
            />
          ))}
        </Group>
      )}
      <Dialog open={!!file} onClose={() => setFile('')} title={file}>
        <pre className="v2-project-source">
          {blob.data?.content || blob.data?.omitted || 'Loading…'}
        </pre>
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
