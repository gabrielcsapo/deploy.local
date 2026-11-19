'use client';
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useRouter } from 'react-flight-router/client';
import { Action, Banner, Composer, Head, Icon, IconButton, Skeleton } from '@/components/ui';
import { Conversation, ReleaseProgress } from '../conversation/Conversation';
import { authenticatedFetch, useInbox } from '../data/hooks';
import { useDataSeed, readSeeded } from '../data/seeds';
import { useProjectFormatting } from '../projects/formatting';
import { useTask } from './data';
import { PullDescription } from './description.client';
import {
  mergeAndRelease,
  mergePull,
  parsePatch,
  readPullChecks,
  requestJson,
  workspaceCommand,
} from './api';
import { ShipDialog } from './ShipDialog';
import { DeleteTaskDialog } from './DeleteTaskDialog';
import { workingStatus } from '../data/sidebar';
import type { TaskCheck, TaskDiff } from './types';
import { TaskChecks, TaskFiles, TaskPanel } from './details.client';
import {
  designCheckWaiting,
  latestChecks,
  taskCheckpoints,
  taskStatus,
  taskUpdatedAt,
  waitingForComputer,
} from './presentation';
import { BrowserPane, PaneDescription, PaneFiles, PaneHead, useTaskBrowser } from './panes.client';
import { descriptionSummary, taskPaneFromPath, type TaskPane } from './panes';
import './style.css';
import { DesignCard, DesignReview, useTaskDesign } from '../design/Review';

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
export default function TaskPage() {
  const { pathname } = useLocation();
  const id = decodeURIComponent(pathname.split('/')[3] || '');
  return <Task key={id} id={id} pathname={pathname} />;
}
function Task({ id, pathname }: { id: string; pathname: string }) {
  const seed = useDataSeed();
  const { formatTime } = useProjectFormatting();
  const { view, error, refresh, updateRelease } = useTask(id);
  const inbox = useInbox();
  const base = `/dashboard/tasks/${encodeURIComponent(id)}`;
  const { navigate } = useRouter();
  // The chat stays in view; changes, checks and the browser open in a pane beside it.
  const { pane: routePane, main } = taskPaneFromPath(pathname);
  // A task that changed its project's design gets a Design tab and a decision in its chat.
  const design = useTaskDesign(view?.project?.id, id);
  const [diff, setDiff] = useState<TaskDiff | null>(
    () => (seed?.data[`/api/tasks/${encodeURIComponent(id)}/diff`] as TaskDiff) ?? null,
  );
  const [checks, setChecks] = useState<TaskCheck[]>([]);
  const [detailVersion, setDetailVersion] = useState(0);
  const [detailError, setDetailError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [sent, setSent] = useState(0);
  const [shipOpen, setShipOpen] = useState(false);
  const [shipped, setShipped] = useState<string>();
  // Task details is open by default on wide windows; choosing it opens it on narrow ones too.
  const [details, setDetails] = useState<boolean | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1180px)');
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const [hint, setHint] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const pull = view?.pulls.at(-1);
  const projectId = view?.project?.id;
  const pullId = pull?.id;
  const pullRevision = pull?.revision;
  const taskRevision = view?.task.revision;
  const loaded = !!view;
  const pane: TaskPane | null =
    main !== 'chat' ? null : (routePane ?? (details !== false ? 'details' : null));
  const chosen = !!routePane || details === true;
  const browser = useTaskBrowser(id, pane === 'browser');
  const hasBrowser = !!browser.session;
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
        ? `/api/projects/${encodeURIComponent(projectId)}/pulls/${encodeURIComponent(pullId)}`
        : `/api/tasks/${encodeURIComponent(id)}`;
    setDetailError('');
    async function loadDetails() {
      try {
        const data = await readSeeded(detailVersion === 0 ? seed : undefined, `${path}/diff`, () =>
          requestJson<TaskDiff & { checks?: TaskCheck[] }>(authenticatedFetch, `${path}/diff`, {
            signal,
          }),
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
          setChecks(latestChecks(currentChecks));
        } else setChecks([]);
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
  }, [id, projectId, pullId, pullRevision, taskRevision, detailVersion, loaded, seed]);
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
      setDetailVersion((value) => value + 1);
      setMore(false);
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
  const {
    checkpoint,
    checks: currentChecks,
    earlier,
    headChecks,
  } = taskCheckpoints(view, checks, diff?.headCommit);
  const waitingNeeds = waitingForComputer(view.needs);
  // Nothing has run while it waits for a computer, so no other status applies.
  const summary = waitingNeeds
    ? { label: 'Waiting for a computer', detail: undefined, icon: 'clock' as const }
    : taskStatus(view, detailError ? null : diff, headChecks, currentChecks);
  const waiting = view.events.some(
    (event) =>
      event.kind === 'decision' &&
      inbox.items.some((item) => item.id === event.inboxItemId && item.state === 'waiting'),
  );
  const updatedAt = pull || view.checkpoint ? taskUpdatedAt(view, currentChecks) : undefined;
  const mergeable = pull?.status === 'open' && diff?.mergeable === true && !detailError;
  // Below 1180 px task details is closed until someone opens it, whatever the default.
  const shown = (item: TaskPane) =>
    pane === item && main === 'chat' && (item !== 'details' || details === true || !narrow);
  const togglePane = (next: TaskPane) => {
    if (shown(next)) {
      if (next === 'details') setDetails(false);
      else navigate(base);
    } else if (next === 'details') {
      setDetails(true);
      if (routePane || main !== 'chat') navigate(base);
    } else navigate(`${base}/${next}`);
  };
  const closePane = () => (pane === 'details' ? setDetails(false) : navigate(base));
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  const checkCount = currentChecks.length + (view.designCheck ? 1 : 0);
  const paneButtons: {
    pane: TaskPane;
    icon: 'list' | 'diff' | 'check' | 'globe';
    label: string;
  }[] = [
    { pane: 'details', icon: 'list', label: 'Task details' },
    {
      pane: 'changes',
      icon: 'diff',
      label: diff ? `Changes, ${files.length} ${files.length === 1 ? 'file' : 'files'}` : 'Changes',
    },
    { pane: 'checks', icon: 'check', label: checkCount ? `Checks, ${checkCount}` : 'Checks' },
    ...(hasBrowser || routePane === 'browser'
      ? [
          {
            pane: 'browser' as const,
            icon: 'globe' as const,
            label: browser.inUse ? 'Browser, in use' : 'Browser',
          },
        ]
      : []),
  ];

  const detailBanner = detailError && (
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
  );
  return (
    <div
      className={`dl-task-layout ${pane ? `with-pane pane-${pane}` : ''} ${chosen ? 'pane-chosen' : ''}`}
    >
      <div className="dl-task-main">
        <header className="dl-task-head">
          <div className="dl-task-wrap">
            <div className="dl-task-title">
              <IconButton
                className="dl-menu-btn"
                icon="menu"
                label="Show sidebar"
                onClick={() => window.dispatchEvent(new Event('deploy:v2-sidebar'))}
              />
              <h1>{view.task.title}</h1>
              <span className="dl-end">
                <span className="dl-task-tools" role="toolbar" aria-label="Task panes">
                  {paneButtons.map((item) => {
                    const on = shown(item.pane) || (item.pane === 'changes' && main === 'full');
                    return (
                      <button
                        type="button"
                        key={item.pane}
                        className={`dl-icon-btn ${on ? 'on' : ''}`}
                        aria-label={item.label}
                        aria-pressed={on}
                        title={item.label}
                        onClick={() => togglePane(item.pane)}
                      >
                        <Icon name={item.icon} />
                        {item.pane === 'browser' && browser.inUse && (
                          <span className="dl-dot" aria-hidden="true" />
                        )}
                      </button>
                    );
                  })}
                  {!!design.count && (
                    <button
                      type="button"
                      className={`dl-icon-btn ${main === 'design' ? 'on' : ''}`}
                      aria-label={`Design, ${design.count}`}
                      aria-pressed={main === 'design'}
                      title="Design"
                      onClick={() => navigate(main === 'design' ? base : `${base}/design`)}
                    >
                      <Icon name="layers" />
                    </button>
                  )}
                </span>
                <div
                  className="dl-task-more"
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) setMore(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setMore(false);
                  }}
                >
                  <button
                    type="button"
                    className="dl-icon-btn"
                    aria-label="More task actions"
                    aria-expanded={more}
                    aria-controls="task-actions"
                    onClick={() => setMore(!more)}
                  >
                    <Icon name="more" />
                  </button>
                  {more && (
                    <div className="dl-task-menu" id="task-actions">
                      {pull?.status === 'open' && (
                        <>
                          <Action
                            variant="quiet"
                            disabled={!mergeable || busy}
                            title={diff?.mergeBlock || undefined}
                            onClick={() =>
                              void act(() => mergePull(authenticatedFetch, projectId!, pull, diff!))
                            }
                          >
                            {designCheckWaiting(view)
                              ? 'Merge without the design check'
                              : 'Merge only'}
                          </Action>
                          {!!view.comparison?.behind && (
                            <Action
                              variant="quiet"
                              disabled={busy}
                              onClick={() =>
                                void act(() =>
                                  workspaceCommand(
                                    authenticatedFetch,
                                    `/tasks/${encodeURIComponent(id)}/update-base`,
                                    { action: 'update' },
                                  ),
                                )
                              }
                            >
                              Update from main
                            </Action>
                          )}
                          <Action
                            variant="quiet"
                            disabled={busy}
                            onClick={() =>
                              void act(() =>
                                workspaceCommand(
                                  authenticatedFetch,
                                  `/projects/${encodeURIComponent(projectId!)}/pulls/${encodeURIComponent(pull.id)}/close`,
                                  { revision: pull.revision },
                                ),
                              )
                            }
                          >
                            Close pull request
                          </Action>
                        </>
                      )}
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
                      {!workingStatus(view.run?.status) && (
                        <Action
                          variant="quiet"
                          className="dl-del"
                          onClick={() => {
                            setMore(false);
                            setDeleting(true);
                          }}
                        >
                          Delete task…
                        </Action>
                      )}
                    </div>
                  )}
                </div>
                {mergeable && (
                  <Action
                    variant="primary"
                    loading={busy}
                    disabled={designCheckWaiting(view)}
                    onClick={() =>
                      void act(async () => {
                        const item = await mergeAndRelease(
                          authenticatedFetch,
                          projectId!,
                          pull!,
                          diff!,
                        );
                        setShipped(item.id);
                        updateRelease(item);
                      })
                    }
                  >
                    Merge and release
                  </Action>
                )}
              </span>
            </div>
            <div className="dl-task-status">
              <span className="dl-status dl-task-state">
                <Icon
                  name={summary.icon}
                  className={
                    summary.icon === 'check'
                      ? 'dl-ok'
                      : summary.icon === 'close'
                        ? 'dl-fail'
                        : summary.icon === 'running'
                          ? 'dl-run dl-spin'
                          : designCheckWaiting(view)
                            ? 'dl-wait'
                            : ''
                  }
                />
                {summary.label}
              </span>
              {summary.detail && (
                <>
                  <span className="dl-task-sep" aria-hidden="true">
                    ·
                  </span>
                  <span>{summary.detail}</span>
                </>
              )}
              {view.packages?.map((pkg) => (
                <span key={pkg.name}>
                  <span className="dl-task-sep" aria-hidden="true">
                    {' '}
                    ·{' '}
                  </span>
                  Merging publishes {pkg.name} {pkg.version}
                </span>
              ))}
              {updatedAt && (
                <>
                  <span className="dl-task-sep" aria-hidden="true">
                    ·
                  </span>
                  <span>Updated {formatTime(updatedAt).toLowerCase()}</span>
                </>
              )}
            </div>
          </div>
        </header>
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
          {main === 'design' && view.project ? (
            <DesignReview projectId={view.project.id} taskId={id} design={design} />
          ) : main === 'chat' ? (
            <div className="dl-task-wrap dl-task-chat">
              {waitingNeeds && (
                <div className="dl-task-notice">
                  <Banner title={waitingNeeds.title}>{waitingNeeds.detail}</Banner>
                  <p className="dl-meta dl-task-needs-asked">{waitingNeeds.asked}</p>
                </div>
              )}
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
                  showAuthors: false,
                }}
              />
              {view.project && design.boards.length > 0 && (
                <DesignCard
                  projectId={view.project.id}
                  taskId={id}
                  design={design}
                  events={view.events}
                />
              )}
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
            <div className="dl-task-wrap dl-task-changes">
              {detailBanner}
              {pull && view.project && (
                <PullDescription
                  pull={pull}
                  projectId={view.project.id}
                  drafter={`Written by the agent${pull.createdAt ? ` · ${formatTime(pull.createdAt)}` : ''}`}
                  onSaved={refresh}
                />
              )}
              {diff ? (
                <TaskFiles files={files} />
              ) : (
                !detailError && <Skeleton rows={4} label="Loading changes" />
              )}
              {diff && !files.length && (
                <p className="dl-meta">{diff.status || 'No changed files on this version.'}</p>
              )}
            </div>
          )}
        </div>
        {main === 'chat' && (
          <div className="dl-dock dl-task-wrap">
            <Composer
              key={sent}
              task={{
                computerId: view.computerId,
                computer: view.computer,
                running: ['queued', 'starting', 'running', 'unknown'].includes(
                  view.run?.status ?? '',
                ),
                onMoved: refresh,
              }}
              model={view.run?.modelName || view.run?.model || 'Default'}
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
      {pane === 'details' && <TaskPanel view={view} base={base} onClose={closePane} />}
      {pane === 'changes' && (
        <aside className="dl-task-pane" aria-label="Changes">
          <PaneHead
            title="Changes"
            meta={
              diff && (
                <>
                  {files.length} {files.length === 1 ? 'file' : 'files'} ·{' '}
                  <span className="dl-add">+{added}</span>{' '}
                  <span className="dl-del">−{removed}</span>
                </>
              )
            }
            onClose={closePane}
          >
            <Action variant="quiet" onClick={() => navigate(`${base}/changes/full`)}>
              Open full view
            </Action>
          </PaneHead>
          <div className="dl-pane-scroll">
            {detailBanner}
            {pull && view.project && (
              <PaneDescription summary={descriptionSummary(pull.body)}>
                <PullDescription
                  pull={pull}
                  projectId={view.project.id}
                  drafter={`Written by the agent${pull.createdAt ? ` · ${formatTime(pull.createdAt)}` : ''}`}
                  onSaved={refresh}
                />
              </PaneDescription>
            )}
            {diff ? (
              <PaneFiles key={diff.headCommit || ''} files={files} />
            ) : (
              !detailError && <Skeleton rows={4} label="Loading changes" />
            )}
            {diff && !files.length && (
              <p className="dl-meta">{diff.status || 'No changed files on this version.'}</p>
            )}
            {diff && !!files.length && (
              <p className="dl-meta">
                Changes since {pull?.targetBranch || 'main'}
                {(pull?.sourceBranch || view.task.branch) &&
                  `, on ${pull?.sourceBranch || view.task.branch}`}
                . Updated as the agent edits.
              </p>
            )}
          </div>
        </aside>
      )}
      {pane === 'checks' && (
        <aside className="dl-task-pane" aria-label="Checks">
          <PaneHead title="Checks" onClose={closePane} />
          <div className="dl-pane-scroll dl-task-checks">
            {detailBanner}
            {!diff && pull ? (
              !detailError && <Skeleton rows={3} label="Loading checks" />
            ) : (
              <TaskChecks
                view={view}
                checks={currentChecks}
                checkpoint={checkpoint}
                earlier={earlier}
              />
            )}
          </div>
        </aside>
      )}
      {pane === 'browser' && (
        <BrowserPane
          taskId={id}
          computer={view.computer}
          agent={view.agent?.name}
          browser={browser}
          onClose={closePane}
        />
      )}
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
      <DeleteTaskDialog
        task={deleting ? { id: view.task.id, title: view.task.title } : null}
        onClose={() => setDeleting(false)}
      />
    </div>
  );
}
