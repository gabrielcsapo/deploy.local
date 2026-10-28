'use client';
import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-flight-router/client';
import {
  Action,
  Banner,
  Composer,
  Diff,
  Head,
  Icon,
  IconButton,
  Skeleton,
  Tabs,
  Term,
} from '@/components/ui';
import { Conversation, ReleaseProgress } from '../conversation/Conversation';
import { authenticatedFetch } from '../data/hooks';
import { useTask } from './data';
import { mergePull, parsePatch, readPullChecks, requestJson, workspaceCommand } from './api';
import { ShipDialog } from './ShipDialog';
import type { TaskCheck, TaskDiff, TaskView } from './types';
import './style.css';

function FirstTask({ onClose }: { onClose: () => void }) {
  return (
    <section className="dl-first-task">
      <div>
        Your first task
        <Action variant="quiet" onClick={onClose}>
          Got it
        </Action>
      </div>
      <ol>
        <li>
          <span>1 of 3</span>
          <strong>Task</strong>Scout works in its own copy of the code, on a free computer
        </li>
        <li>
          <span>2 of 3</span>
          <strong>Pull request</strong>You review the change; a second model reviews it first
        </li>
        <li>
          <span>3 of 3</span>
          <strong>Release</strong>Merging ships it, and every app in the project moves together
        </li>
      </ol>
    </section>
  );
}
function TaskPanel({
  view,
  files,
  onShip,
  base,
}: {
  view: TaskView;
  files: ReturnType<typeof parsePatch>;
  onShip: () => void;
  base: string;
}) {
  return (
    <aside className="dl-task-panel" aria-label="This task">
      <div className="dl-panel-head">This task</div>
      <div className="dl-panel-body">
        {view.project && (
          <>
            <div className="dl-panel-label">Project</div>
            <a
              className="dl-panel-item"
              href={`/dashboard/projects/${encodeURIComponent(view.project.id)}`}
            >
              <Icon name="folder" />
              <span>{view.project.name}</span>
            </a>
            <div className="dl-panel-item">
              <Icon name="merge" />
              <span className="dl-t">
                <span>{view.project.repository || 'Repository address unavailable'}</span>
                <span>
                  {view.pulls.at(-1)?.sourceBranch || view.task.sourceRef || 'Branch unavailable'}
                </span>
              </span>
            </div>
          </>
        )}
        <div className="dl-panel-label">Running on</div>
        <div className="dl-panel-item">
          <Icon name="computer" />
          <span className="dl-t">
            <span>{view.computer || 'Unavailable'}</span>
            <span>{view.run?.model || 'Model unavailable'}</span>
          </span>
        </div>
        {!!files.length && (
          <>
            <div className="dl-panel-label">Work</div>
            <a className="dl-panel-item" href={`${base}/changes`}>
              {files.length} files changed
            </a>
            {files.map((file) => (
              <a
                className="dl-task-file"
                href={`${base}/changes#${encodeURIComponent(file.file)}`}
                key={file.file}
              >
                {file.file}
                <span className="dl-add">+{file.added}</span>
                <span className="dl-del">−{file.removed}</span>
              </a>
            ))}
          </>
        )}
        {!!view.pulls.length && (
          <>
            <div className="dl-panel-label">Pull requests</div>
            {view.pulls.map((pull) => (
              <a className="dl-panel-item" key={pull.id} href={`${base}/changes`}>
                #{pull.number} · {pull.title}
              </a>
            ))}
          </>
        )}
        {!!view.screenshots.length && (
          <>
            <div className="dl-panel-label">Screenshots</div>
            {view.screenshots.map((shot) => (
              <a key={shot.id} className="dl-panel-item" href={`${base}#screenshot-${shot.id}`}>
                {shot.target.device || shot.target.kind}
              </a>
            ))}
          </>
        )}
        {!!view.releases.length && (
          <>
            <div className="dl-panel-label">Releases</div>
            {view.releases.map((release) => (
              <a
                key={release.id}
                className="dl-panel-item"
                href={`/dashboard/projects/${encodeURIComponent(release.projectId)}/releases/${encodeURIComponent(release.id)}`}
              >
                {release.id} · {release.state === 'live' ? 'Live' : release.state}
              </a>
            ))}
          </>
        )}
        {view.project && (
          <Action onClick={onShip} disabled={!view.ship?.ref}>
            Ship…
          </Action>
        )}
        <div className="dl-panel-label">Started</div>
        <div className="dl-panel-item">
          <Icon name="clock" />
          {new Date(view.task.createdAt).toLocaleString()}
        </div>
      </div>
    </aside>
  );
}
export default function TaskPage() {
  const { pathname } = useLocation();
  const id = decodeURIComponent(pathname.split('/')[3] || '');
  return <Task key={id} id={id} pathname={pathname} />;
}
function Task({ id, pathname }: { id: string; pathname: string }) {
  const { view, error, refresh, updateRelease } = useTask(id);
  const base = `/dashboard/tasks/${encodeURIComponent(id)}`;
  const tab = pathname.endsWith('/changes')
    ? 'changes'
    : pathname.endsWith('/checks')
      ? 'checks'
      : 'chat';
  const [diff, setDiff] = useState<TaskDiff | null>(null);
  const [checks, setChecks] = useState<TaskCheck[]>([]);
  const [detailVersion, setDetailVersion] = useState(0);
  const [detailError, setDetailError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(0);
  const [shipOpen, setShipOpen] = useState(false);
  const [shipped, setShipped] = useState<string>();
  const [panel, setPanel] = useState<boolean | null>(null);
  const [hint, setHint] = useState(false);
  const pull = view?.pulls.at(-1);
  const projectId = view?.project?.id;
  const pullId = pull?.id;
  const pullRevision = pull?.revision;
  const taskRevision = view?.task.revision;
  const loaded = !!view;
  const panelOpen = panel ?? !!(view?.screenshots.length || pull);
  useEffect(() => {
    setShipOpen(window.location.hash === '#ship');
    setHint(localStorage.getItem('deploy-v2-first-task-seen') !== 'yes');
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const controller = new AbortController();
    const signal = controller.signal;
    const path =
      pullId && projectId
        ? `/api/workspace/projects/${encodeURIComponent(projectId)}/pulls/${encodeURIComponent(pullId)}`
        : `/api/workspace/tasks/${encodeURIComponent(id)}`;
    setDetailError('');
    async function loadDetails() {
      try {
        const data = await requestJson<TaskDiff & { checks?: TaskCheck[] }>(
          authenticatedFetch,
          `${path}/diff`,
          { signal },
        );
        if (signal.aborted) return;
        setDiff(data);
        setChecks([]);
        if (pullId && projectId && data.headCommit) {
          const currentChecks = await readPullChecks(
            authenticatedFetch,
            projectId,
            pullId,
            data.headCommit,
            signal,
          );
          if (!signal.aborted) setChecks(currentChecks);
        } else setChecks(data.checks || []);
      } catch {
        if (!signal.aborted) {
          setDiff(null);
          setChecks([]);
          setDetailError('Changes or checks are unavailable. Retry to load the current version.');
        }
      }
    }
    void loadDetails();
    return () => controller.abort();
  }, [id, projectId, pullId, pullRevision, taskRevision, detailVersion, loaded]);
  useEffect(() => {
    const timer = setInterval(() => setDetailVersion((value) => value + 1), 10000);
    return () => clearInterval(timer);
  }, []);
  const files = useMemo(() => parsePatch(diff?.patch || ''), [diff]);
  async function act(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setActionError('');
    try {
      await action();
      refresh();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Could not save. Try again.');
    } finally {
      setBusy(false);
    }
  }
  if (!view)
    return (
      <>
        <Head title="Task" />
        <div className="dl-col">
          {error ? (
            <Banner title={error} action={<Action onClick={refresh}>Retry</Action>} />
          ) : (
            <Skeleton rows={5} label="Loading task" />
          )}
        </div>
      </>
    );
  const status = view.run?.status || view.task.status;
  const stalled = ['unknown', 'stalled', 'interrupted', 'blocked'].includes(status);
  const failed = status === 'failed';
  const release = view.releases.find((item) => item.id === shipped);
  return (
    <div className={`dl-task-layout ${panelOpen ? 'with-panel' : ''}`}>
      <div className="dl-task-main">
        <Head
          title={view.task.title}
          subtitle={`${view.project?.name || 'New task'} · ${view.computer || 'Computer unavailable'}`}
          menu={
            <IconButton
              className="dl-menu-btn"
              icon="menu"
              label="Open navigation"
              onClick={() => window.dispatchEvent(new Event('deploy:v2-sidebar'))}
            />
          }
          actions={
            <>
              {view.project && (
                <Action
                  variant="quiet"
                  disabled={!view.ship?.ref}
                  onClick={() => setShipOpen(true)}
                >
                  Ship…
                </Action>
              )}
              <IconButton
                icon="panel"
                label="This task"
                aria-pressed={panelOpen}
                onClick={() => setPanel(!panelOpen)}
              />
            </>
          }
        />
        <div className="dl-task-bar">
          <Tabs
            items={[
              { label: 'Chat', href: base },
              { label: 'Changes', href: `${base}/changes` },
              { label: 'Checks', href: `${base}/checks` },
            ]}
            value={tab === 'chat' ? base : `${base}/${tab}`}
          />
          <span className="dl-meta">
            {pull
              ? `PR #${pull.number} · ${pull.status}`
              : status === 'running'
                ? 'Running'
                : view.releases.length
                  ? 'Released'
                  : 'Not released yet'}
          </span>
          {pull?.status === 'open' && (
            <Action
              disabled={!diff?.headCommit || busy}
              onClick={() => void act(() => mergePull(authenticatedFetch, projectId!, pull, diff!))}
            >
              Merge only
            </Action>
          )}
        </div>
        <div className="dl-scroll">
          {(error || actionError) && (
            <div className="dl-col dl-task-notice">
              <Banner
                kind="danger"
                title={actionError || error}
                action={<Action onClick={refresh}>Retry</Action>}
              />
            </div>
          )}
          {tab === 'chat' ? (
            <div className="dl-col">
              {stalled && (
                <div className="dl-task-notice">
                  <Banner title={`${view.computer || 'The computer'} stopped reporting progress`}>
                    The task is paused. Its saved work is still available.
                  </Banner>
                </div>
              )}
              {failed && (
                <div className="dl-task-notice">
                  <Banner kind="danger" title="This task stopped after a failure">
                    Review the work log, then follow up in this task.
                  </Banner>
                </div>
              )}
              {view.firstTask && hint && (
                <FirstTask
                  onClose={() => {
                    localStorage.setItem('deploy-v2-first-task-seen', 'yes');
                    setHint(false);
                  }}
                />
              )}
              <Conversation
                events={view.events}
                resources={{ screenshots: view.screenshots, releases: view.releases }}
              />
              {release &&
                !view.events.some(
                  (event) => event.kind === 'release' && event.releaseId === release.id,
                ) && <ReleaseProgress release={release} />}
            </div>
          ) : (
            <div className={tab === 'changes' ? 'dl-task-changes' : 'dl-col dl-task-checks'}>
              {detailError && (
                <Banner
                  title={detailError}
                  action={
                    <Action
                      onClick={() => {
                        refresh();
                        setDetailVersion((value) => value + 1);
                      }}
                    >
                      Retry
                    </Action>
                  }
                />
              )}
              {tab === 'changes' ? (
                <>
                  <nav className="dl-task-files" aria-label="Changed files">
                    <h3>{files.length} files changed</h3>
                    {files.map((file) => (
                      <a
                        className="dl-task-file"
                        href={`#${encodeURIComponent(file.file)}`}
                        key={file.file}
                      >
                        {file.file}
                        <span className="dl-add">+{file.added}</span>
                        <span className="dl-del">−{file.removed}</span>
                      </a>
                    ))}
                  </nav>
                  <div className="dl-task-diffs">
                    {files.map((file) => (
                      <div id={encodeURIComponent(file.file)} key={file.file}>
                        <Diff file={file.file} lines={file.lines} />
                      </div>
                    ))}
                    {!files.length && (
                      <p className="dl-meta">
                        {diff?.status ||
                          (diff ? 'No changed files on this version.' : 'Loading changes…')}
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <h3>{pull ? `Checks for PR #${pull.number}` : 'Checks on this task'}</h3>
                  {checks.length ? (
                    checks.map((check) => (
                      <details className="dl-task-check" key={check.id}>
                        <summary>
                          <Icon
                            name={
                              ['passed', 'succeeded'].includes(check.status)
                                ? 'check'
                                : check.status === 'running'
                                  ? 'running'
                                  : 'clock'
                            }
                          />
                          <span>{check.name || check.command || check.id}</span>
                          <span className="dl-meta">{check.status}</span>
                        </summary>
                        {check.headCommit && <p className="dl-meta">Version {check.headCommit}</p>}
                        <Term>{check.output || check.error || 'No output recorded.'}</Term>
                      </details>
                    ))
                  ) : (
                    <p className="dl-meta">No checks recorded on this version.</p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
        {tab === 'chat' && (
          <div className="dl-dock">
            <Composer
              key={sent}
              project={view.project?.name || 'New task'}
              computer={view.computer || 'Unavailable'}
              model={view.run?.model || 'Default'}
              loading={busy}
              onSend={(text) =>
                void act(async () => {
                  await workspaceCommand(
                    authenticatedFetch,
                    `/tasks/${encodeURIComponent(id)}/messages`,
                    {
                      revision: view.task.revision,
                      content: text,
                      adapter: view.run?.adapter,
                      model: view.run?.model,
                    },
                  );
                  setSent((value) => value + 1);
                })
              }
            />
          </div>
        )}
      </div>
      <TaskPanel view={view} files={files} base={base} onShip={() => setShipOpen(true)} />
      <ShipDialog
        open={shipOpen}
        onClose={() => setShipOpen(false)}
        view={view}
        release={release}
        onRelease={(item) => {
          setShipped(item.id);
          updateRelease(item);
        }}
      />
    </div>
  );
}
