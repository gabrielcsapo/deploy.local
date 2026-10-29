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
  Term,
} from '@/components/ui';
import { Conversation, ReleaseProgress } from '../conversation/Conversation';
import { authenticatedFetch, useInbox } from '../data/hooks';
import { formatTime } from '../data/time';
import { useTask } from './data';
import { mergePull, parsePatch, readPullChecks, requestJson, workspaceCommand } from './api';
import { ShipDialog } from './ShipDialog';
import type { TaskCheck, TaskDiff, TaskView } from './types';
import './style.css';

function FirstTask({ onClose }: { onClose: () => void }) {
  return (
    <section className="dl-first-task">
      <div>
        <span>
          <Icon name="bulb" /> Your first task
        </span>
        <Action variant="quiet" onClick={onClose}>
          Got it
        </Action>
      </div>
      <ol>
        <li>
          <span>1 of 3</span>
          <strong>Task</strong>The agent works in its own copy of the code, on a free computer
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
  checks,
  detailsAvailable,
  onShip,
  onClose,
  base,
}: {
  view: TaskView;
  files: ReturnType<typeof parsePatch>;
  checks: TaskCheck[];
  detailsAvailable: boolean;
  onShip: () => void;
  onClose: () => void;
  base: string;
}) {
  const passed = checks.filter((check) => ['passed', 'succeeded'].includes(check.status));
  const additions = files.reduce((sum, file) => sum + file.added, 0);
  const removals = files.reduce((sum, file) => sum + file.removed, 0);
  const pull = view.pulls.at(-1);
  return (
    <aside className="dl-task-panel" aria-label="This task">
      <div className="dl-panel-head">
        This task
        <span className="dl-end">
          <IconButton icon="close" label="Close task panel" onClick={onClose} />
        </span>
      </div>
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
                <span>{pull?.sourceBranch || view.task.sourceRef || 'Branch unavailable'}</span>
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
        <div className="dl-panel-label">Work</div>
        <a className="dl-panel-item" href={`${base}/changes`}>
          <Icon name="file" />
          <span className="dl-t">
            <span>
              {detailsAvailable ? `${files.length} files changed` : 'Changes unavailable'}
            </span>
            <span>
              <span className="dl-add">{detailsAvailable ? `+${additions}` : ''}</span>{' '}
              <span className="dl-del">{detailsAvailable ? `−${removals}` : ''}</span> · Changes
            </span>
          </span>
        </a>
        <a className="dl-panel-item" href={`${base}/checks`}>
          <Icon name={passed.length ? 'check' : 'clock'} className={passed.length ? 'dl-ok' : ''} />
          <span className="dl-t">
            <span>
              {!detailsAvailable
                ? 'Checks unavailable'
                : passed.length
                  ? `${passed.length} checks passed`
                  : 'No checks passed yet'}
            </span>
            <span>
              {!detailsAvailable
                ? 'Load this version’s checks to see what ran'
                : checks.length
                  ? checks.map((check) => check.name || check.command || check.id).join(', ')
                  : 'No checks recorded on this version'}
            </span>
          </span>
        </a>
        {!!view.screenshots.length && (
          <>
            <div className="dl-panel-label">Screenshots</div>
            <a className="dl-panel-item" href={`${base}#screenshot-${view.screenshots[0].id}`}>
              <Icon name="computer" />
              <span className="dl-t">
                <span>{view.screenshots.length} screenshots</span>
                <span>
                  {view.screenshots[0].requestedAt ? 'Asked for at ' : 'Taken at '}
                  {formatTime(
                    view.screenshots[0].requestedAt || view.screenshots[0].takenAt,
                    'clock',
                  )}
                </span>
              </span>
            </a>
          </>
        )}
        <div className="dl-panel-label">Releases</div>
        {view.releases.length ? (
          view.releases.map((release) => (
            <a
              key={release.id}
              className="dl-panel-item"
              href={`/dashboard/projects/${encodeURIComponent(release.projectId)}/releases/${encodeURIComponent(release.id)}`}
            >
              <Icon name="cloud" />
              {release.id} · {release.state === 'live' ? 'Live' : release.state}
            </a>
          ))
        ) : (
          <div className="dl-panel-item">
            <Icon name="cloud" />
            <span className="dl-t">
              <span>None yet</span>
              <span>Ship it whenever you are ready</span>
            </span>
          </div>
        )}
        {view.project && (
          <Action onClick={onShip} disabled={!view.ship?.ref}>
            Ship…
          </Action>
        )}
        <div className="dl-panel-label">Started</div>
        <div className="dl-panel-item">
          <Icon name="clock" />
          <span className="dl-t">
            <span>
              {view.task.startedBy ? `By ${view.task.startedBy}, ` : ''}
              {formatTime(view.task.createdAt)}
            </span>
            <span>{view.task.startedFrom || 'Task source unavailable'}</span>
          </span>
        </div>
        {!!view.pulls.length && (
          <>
            <div className="dl-panel-label">Pull requests</div>
            {view.pulls.map((item) => (
              <a className="dl-panel-item" key={item.id} href={`${base}/changes`}>
                #{item.number} · {item.title}
              </a>
            ))}
          </>
        )}
        {pull && (
          <>
            <div className="dl-panel-label">Merge</div>
            <div className="dl-panel-item">
              <Icon name="merge" />
              <span className="dl-t">
                <span>
                  PR #{pull.number} · {pull.status}
                </span>
                <span>Checks on this version are shown above</span>
              </span>
            </div>
          </>
        )}
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
  const inbox = useInbox();
  const base = `/dashboard/tasks/${encodeURIComponent(id)}`;
  const tab = pathname.endsWith('/changes')
    ? 'changes'
    : pathname.endsWith('/checks')
      ? 'checks'
      : 'chat';
  const [diff, setDiff] = useState<TaskDiff | null>(null);
  const [checks, setChecks] = useState<TaskCheck[]>([]);
  const [selectedCheck, setSelectedCheck] = useState<string>();
  const [detailVersion, setDetailVersion] = useState(0);
  const [detailError, setDetailError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
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

        if (pullId && projectId && data.headCommit) {
          const currentChecks = await readPullChecks(
            authenticatedFetch,
            projectId,
            pullId,
            data.headCommit,
            signal,
          );
          if (signal.aborted) return;
          setChecks(currentChecks);
        } else setChecks(data.checks || []);
        setDiff(data);
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
  const passed = checks.filter((check) => ['passed', 'succeeded'].includes(check.status));
  const waiting = view.events.some(
    (event) =>
      event.kind === 'decision' &&
      inbox.items.some((item) => item.id === event.inboxItemId && item.state === 'waiting'),
  );
  const runLabel = stalled
    ? 'Paused'
    : failed
      ? 'Stopped'
      : status === 'running'
        ? 'Running'
        : view.releases.length
          ? 'Released'
          : 'Not released yet';
  const stateTime =
    status === 'running'
      ? view.checkpoint?.at || view.run?.updatedAt || view.task.createdAt
      : view.task.createdAt;

  return (
    <div className={`dl-task-layout ${panelOpen ? 'with-panel' : ''}`}>
      <div className="dl-task-main">
        <Head
          title={view.task.title}
          subtitle={`${pull ? `PR #${pull.number} · ` : ''}${view.project?.name || 'New task'} · ${view.computer || 'Computer unavailable'}${stalled ? ' · paused' : failed ? ' · stopped' : ''}`}
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
                <Action disabled={!view.ship?.ref} onClick={() => setShipOpen(true)}>
                  Ship…
                </Action>
              )}
              <IconButton
                icon="panel"
                label="This task"
                aria-pressed={panelOpen}
                onClick={() => setPanel(!panelOpen)}
              />
              <div className="dl-task-more">
                <button
                  type="button"
                  className="dl-icon-btn"
                  aria-label="More task actions"
                  aria-expanded={more}
                  onClick={() => setMore(!more)}
                >
                  ⋯
                </button>
                {more && (
                  <div className="dl-task-menu">
                    <Action
                      variant="quiet"
                      onClick={() => {
                        refresh();
                        setDetailVersion((value) => value + 1);
                        setMore(false);
                      }}
                    >
                      Refresh task
                    </Action>
                    {view.project && (
                      <a href={`/dashboard/projects/${encodeURIComponent(view.project.id)}`}>
                        Open project
                      </a>
                    )}
                  </div>
                )}
              </div>
            </>
          }
        />
        <div className="dl-task-bar">
          <nav className="dl-seg" aria-label="Task sections">
            {['chat', 'changes', 'checks'].map((section) => (
              <a
                key={section}
                href={section === 'chat' ? base : `${base}/${section}`}
                className={tab === section ? 'on' : ''}
                aria-current={tab === section ? 'page' : undefined}
              >
                {section[0].toUpperCase() + section.slice(1)}
                {section === 'checks' && passed.length > 0 && (
                  <span className="dl-meta">{passed.length} passed</span>
                )}
              </a>
            ))}
          </nav>
          <span className="dl-meta">
            {pull
              ? `PR #${pull.number} · ${pull.status}`
              : tab !== 'chat' && !view.releases.length
                ? 'Not a pull request yet'
                : runLabel}
            {view.checkpoint && ` · checkpoint ${view.checkpoint.number}`} ·{' '}
            {formatTime(
              stateTime,
              status === 'running' && view.checkpoint ? 'relative' : 'elapsed',
            )}
          </span>
          <div className="dl-task-bar-actions">
            <Action disabled title="Updating from main is not available on this coordinator yet.">
              Update from main
            </Action>
            {tab !== 'chat' && !pull && (
              <Action
                variant="primary"
                disabled
                title="Publishing a pull request is not available from this task yet."
              >
                Publish pull request
              </Action>
            )}
            {pull?.status === 'open' && (
              <Action
                disabled={!diff?.headCommit || busy}
                onClick={() =>
                  void act(() => mergePull(authenticatedFetch, projectId!, pull, diff!))
                }
              >
                Merge only
              </Action>
            )}
          </div>
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
                resources={{
                  screenshots: view.screenshots,
                  releases: view.releases,
                  showAuthors: !!pull,
                }}
              />
              {waiting && !stalled && !failed && !pull && (
                <div className="dl-task-waiting">
                  <Icon name="running" className="dl-run dl-spin" size={14} />
                  Waiting for your answer
                </div>
              )}
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
                  <div className="dl-group">
                    <div className="dl-task-check-head">
                      <span>
                        {view.checkpoint
                          ? `Checkpoint ${view.checkpoint.number}`
                          : pull
                            ? `Checks for PR #${pull.number}`
                            : 'Checks on this task'}
                      </span>
                      <Action
                        variant="quiet"
                        disabled
                        title="Rerunning checks is not available for this version yet."
                      >
                        Run again
                      </Action>
                    </div>
                    {checks.length ? (
                      checks.map((check) => {
                        const ok = ['passed', 'succeeded'].includes(check.status);
                        const running = check.status === 'running';
                        const endedAt = check.finishedAt || check.completedAt;
                        const duration =
                          check.startedAt && (running || endedAt)
                            ? formatTime(
                                check.startedAt,
                                'elapsed',
                                endedAt ? new Date(endedAt) : undefined,
                              )
                            : undefined;
                        const label = ok
                          ? 'Passed'
                          : running
                            ? 'Running'
                            : check.status === 'failed'
                              ? 'Failed'
                              : check.status;
                        return (
                          <button
                            type="button"
                            className="dl-task-check"
                            key={check.id}
                            onClick={() => setSelectedCheck(check.id)}
                            aria-pressed={(selectedCheck || checks[0]?.id) === check.id}
                          >
                            <Icon
                              name={
                                ok
                                  ? 'check'
                                  : running
                                    ? 'running'
                                    : check.status === 'failed'
                                      ? 'close'
                                      : 'clock'
                              }
                              className={
                                ok
                                  ? 'dl-ok'
                                  : running
                                    ? 'dl-run dl-spin'
                                    : check.status === 'failed'
                                      ? 'dl-fail'
                                      : ''
                              }
                            />
                            <span className="dl-t">
                              <span>{check.name || check.command || check.id}</span>
                              {check.command && <span className="dl-mono">{check.command}</span>}
                            </span>
                            <span className="dl-meta">
                              {label}
                              {duration && ` · ${duration}`}
                            </span>
                          </button>
                        );
                      })
                    ) : (
                      <p className="dl-meta dl-inset">
                        {diff ? 'No checks recorded on this version.' : 'Checks unavailable.'}
                      </p>
                    )}
                  </div>
                  {!!checks.length && (
                    <Term>
                      {(checks.find((check) => check.id === selectedCheck) || checks[0]).output ||
                        (checks.find((check) => check.id === selectedCheck) || checks[0]).error ||
                        'No output recorded.'}
                    </Term>
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
      <TaskPanel
        view={view}
        files={files}
        checks={checks}
        detailsAvailable={!!diff && !detailError}
        base={base}
        onShip={() => setShipOpen(true)}
        onClose={() => setPanel(false)}
      />
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
