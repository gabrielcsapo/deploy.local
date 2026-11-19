'use client';
import { useEffect, useMemo, useState } from 'react';
import { askedTime } from '../inbox/presentation';
import type { InboxItem } from '../../../../../shared/v2/contracts';
import { useLocation } from 'react-flight-router/client';
import { Action, Banner, Composer, Head, Icon, IconButton, Skeleton, Tabs } from '@/components/ui';
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
  const tab = pathname.endsWith('/changes')
    ? 'changes'
    : pathname.endsWith('/checks')
      ? 'checks'
      : pathname.endsWith('/design')
        ? 'design'
        : 'chat';
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
  const [panel, setPanel] = useState<boolean | null>(null);
  const [hint, setHint] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const pull = view?.pulls.at(-1);
  const projectId = view?.project?.id;
  const pullId = pull?.id;
  const pullRevision = pull?.revision;
  const taskRevision = view?.task.revision;
  const loaded = !!view;
  const panelOpen = panel ?? true;
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
  // The question the agent is waiting on: the composer answers it, and it stays in view.
  const waitingQuestion = view.events
    .flatMap((event) =>
      event.kind === 'decision'
        ? inbox.items.filter(
            (item) =>
              item.id === event.inboxItemId && item.state === 'waiting' && item.kind === 'question',
          )
        : [],
    )
    .at(-1);
  // Nothing runs while the agent waits on you, so that is what the header says.
  const shown = waitingQuestion
    ? {
        label: 'Waiting for your answer',
        detail: askedTime(waitingQuestion.createdAt),
        icon: 'attention' as const,
      }
    : summary;
  const answerable = waitingQuestion?.actions.some((action) => action.id === 'answer');
  const waitingItems = view.events.flatMap((event) =>
    event.kind === 'decision'
      ? inbox.items.filter((item) => item.id === event.inboxItemId && item.state === 'waiting')
      : [],
  );
  const waiting = waitingItems.length > 0;
  const updatedAt = pull || view.checkpoint ? taskUpdatedAt(view, currentChecks) : undefined;
  const mergeable = pull?.status === 'open' && diff?.mergeable === true && !detailError;
  const tabs = [
    { label: 'Chat', href: base },
    { label: 'Changes', href: `${base}/changes`, count: diff ? files.length : undefined },
    {
      label: 'Checks',
      href: `${base}/checks`,
      count: currentChecks.length + (view.designCheck ? 1 : 0) || undefined,
    },
    ...(design.count ? [{ label: 'Design', href: `${base}/design`, count: design.count }] : []),
  ];

  return (
    <div className={`dl-task-layout ${panelOpen ? 'with-panel' : ''}`}>
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
                <IconButton
                  className="dl-task-panel-toggle"
                  icon="panel"
                  label="Task details"
                  aria-pressed={panelOpen}
                  onClick={() => setPanel(!panelOpen)}
                />
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
              <span className={`dl-status dl-task-state${waitingQuestion ? ' waiting' : ''}`}>
                <Icon
                  name={shown.icon}
                  className={
                    shown.icon === 'check'
                      ? 'dl-ok'
                      : shown.icon === 'close'
                        ? 'dl-fail'
                        : shown.icon === 'running'
                          ? 'dl-run dl-spin'
                          : designCheckWaiting(view)
                            ? 'dl-wait'
                            : ''
                  }
                />
                {shown.label}
              </span>
              {shown.detail && (
                <>
                  <span className="dl-task-sep" aria-hidden="true">
                    ·
                  </span>
                  <span>{shown.detail}</span>
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
            <Tabs label="Task" items={tabs} value={tab === 'chat' ? base : `${base}/${tab}`} />
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
          {tab === 'design' && view.project ? (
            <DesignReview projectId={view.project.id} taskId={id} design={design} />
          ) : tab === 'chat' ? (
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
                  inTask: true,
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
              {waiting && !waitingQuestion && !stalled && !failed && !pull && (
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
            <div
              className={`dl-task-wrap ${tab === 'changes' ? 'dl-task-changes' : 'dl-task-checks'}`}
            >
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
                </>
              ) : !diff && pull ? (
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
          )}
        </div>
        {tab === 'chat' && (
          <div className="dl-dock dl-task-wrap">
            {waitingQuestion && <QuestionPin item={waitingQuestion} />}
            <Composer
              key={sent}
              task={{
                computerId: view.computerId,
                computer: view.computer,
                running: ['queued', 'starting', 'running', 'unknown'].includes(
                  view.run?.status ?? '',
                ),
                onMoved: refresh,
                ...(waitingQuestion && answerable
                  ? {
                      answer: async (text: string) => {
                        await inbox.answer(waitingQuestion.id, 'answer', text);
                        refresh();
                      },
                    }
                  : {}),
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
      <TaskPanel view={view} base={base} onClose={() => setPanel(false)} />
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

/** While the waiting question is scrolled out of view, it stays above the composer. */
function QuestionPin({ item }: { item: InboxItem }) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const card = document.getElementById(`decision-${item.id}`);
    if (!card) return;
    const observer = new IntersectionObserver(([entry]) => setHidden(!entry.isIntersecting));
    observer.observe(card);
    return () => observer.disconnect();
  }, [item.id]);
  if (!hidden) return null;
  return (
    <a
      className="dl-ask-pin"
      href={`#decision-${item.id}`}
      onClick={(event) => {
        event.preventDefault();
        document
          .getElementById(`decision-${item.id}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }}
    >
      <Icon name="attention" size={14} className="dl-ask-icon" />
      <span className="dl-t">{item.text || item.title}</span>
      <span className="dl-end">Show question</span>
    </a>
  );
}
