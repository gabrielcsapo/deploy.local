'use client';
import { useEffect, useState } from 'react';
import { IconButton, OverflowMenu, Button } from '@/components/ui';
import { WorkspaceTitleBar } from './workspace-title-bar.client';
import { DeploymentEvent, PullRequestEvent, PullRequestBar } from './transcript-events.client';
import { NewTaskPrompt, ComposerContext } from './composer-context.client';
import { TaskTree } from './task-tree.client';
import { TaskActivity } from './task-activity.client';
import { TaskCard } from './task-card.client';
import { ReplyActions } from './reply-actions.client';
import { getAuth } from './detail/shared';
import './conversation-chrome.css';
type Row = Record<string, any>;

/** The specimens use the signed-in workspace; never seed example counts or outcomes. */
export function WorkspaceChromeSpecimen() {
  const [state, setState] = useState<Row | null>(null);
  const [detail, setDetail] = useState<Row | null>(null);
  const [patch, setPatch] = useState<Row | null>(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const auth = getAuth();
    if (!auth) {
      setError('Sign in to see specimens with your workspace data.');
      return;
    }
    const controller = new AbortController();
    const headers = { 'x-deploy-username': auth.username, 'x-deploy-token': auth.token };
    async function load() {
      try {
        const response = await fetch('/api/workspace/state', {
          headers,
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Could not load workspace specimens.');
        const value = await response.json();
        setState(value);
        setSelected(
          value.tasks.toSorted((a: Row, b: Row) =>
            String(b.updatedAt).localeCompare(String(a.updatedAt)),
          )[0]?.id ?? '',
        );
      } catch (failure) {
        if (!controller.signal.aborted) setError(String(failure));
      }
    }
    void load();
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const auth = getAuth();
    if (!auth || !selected) return;
    const controller = new AbortController();
    const headers = { 'x-deploy-username': auth.username, 'x-deploy-token': auth.token };
    setDetail(null);
    setPatch(null);
    void Promise.all(
      ['', '/diff'].map(async (suffix) => {
        const response = await fetch(
          `/api/workspace/tasks/${encodeURIComponent(selected)}${suffix}`,
          { headers, signal: controller.signal },
        );
        if (!response.ok) throw new Error('Could not load task specimen.');
        return response.json();
      }),
    )
      .then(([task, diff]) => {
        setDetail(task);
        setPatch(diff);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(String(failure));
      });
    return () => controller.abort();
  }, [selected]);
  function openTask() {
    window.location.assign(`/dashboard?task=${encodeURIComponent(selected)}`);
  }
  const run = detail?.runs?.at(-1);
  const activity = detail?.activity?.find((turn: Row) => turn.id === run?.id);
  const reply = detail?.messages?.findLast(
    (message: Row) => message.role === 'assistant' && !message.isProgress,
  );
  return (
    <section id="design-workspace-chrome" className="ds-reference-section">
      <h2>Conversation hierarchy</h2>
      <p>
        Projects and Recents, one title bar, elapsed turn summaries, reply utilities and a floating
        task card. These specimens read your actual workspace. Open task to use Changes and
        Activity.
      </p>
      {error && <p role="status">{error}</p>}
      {state && (
        <div className="ds-chrome-specimen">
          <TaskTree
            shortcuts={false}
            projects={state.projects}
            tasks={state.tasks}
            selected={selected}
            loaded
            error=""
            waitingForAnswer={new Set()}
            openTask={setSelected}
            newTask={() => window.location.assign('/dashboard')}
            addRepository={() => window.location.assign('/dashboard/repositories')}
            retry={() => window.location.reload()}
          />
          <div>
            <WorkspaceTitleBar
              title={detail?.task.title ?? 'New task'}
              actions={
                <>
                  <IconButton
                    icon="review"
                    label="Open task changes"
                    onClick={openTask}
                    disabled={!detail}
                  />
                  <IconButton
                    icon="panel-right"
                    label="Open task activity"
                    onClick={openTask}
                    disabled={!detail}
                  />
                  <OverflowMenu label="More task actions">
                    <Button variant="link" onClick={openTask} disabled={!detail}>
                      Open task
                    </Button>
                  </OverflowMenu>
                </>
              }
            />
            <NewTaskPrompt
              projects={state.projects}
              project={detail?.task.projectId || ''}
              computers={state.workers}
              computer={detail?.task.workerId || ''}
              chooseProject={() => {}}
              chooseComputer={() => {}}
              newRepository={openTask}
            />
            <div className="project-workspace ds-phase-one-composer">
              <div className="pw-composer">
                <div className="pw-composer-context-tray">
                  <ComposerContext
                    projects={state.projects}
                    project={detail?.task.projectId || ''}
                    computers={state.workers}
                    computer={detail?.task.workerId || ''}
                    chooseProject={openTask}
                    chooseComputer={openTask}
                    newRepository={openTask}
                  />
                </div>
                <textarea
                  aria-label="Composer specimen"
                  placeholder="Ask, build, or follow up…"
                  readOnly
                  rows={1}
                />
              </div>
            </div>
            {(detail?.pullRequests || []).map((pull: Row) => (
              <div key={pull.id}>
                <PullRequestEvent pull={pull} />
                <PullRequestBar pull={pull} />
              </div>
            ))}
            {(detail?.messages || [])
              .filter((message: Row) => message.deployment)
              .map((message: Row) => (
                <DeploymentEvent key={message.id} deployment={message.deployment} />
              ))}
            {detail?.messages?.find((message: Row) => message.role === 'user') && (
              <div className="project-workspace ds-phase-one-composer">
                <div className="pw-message user">
                  {detail.messages.find((message: Row) => message.role === 'user').content}
                </div>
              </div>
            )}
            {activity && (
              <TaskActivity
                activity={activity}
                run={run}
                jobs={(detail?.jobs ?? []).filter((job: Row) => job.runId === run.id)}
                openActivity={openTask}
              />
            )}
            {reply && (
              <ReplyActions
                message={reply}
                run={detail?.runs?.find((item: Row) => item.id === reply.runId)}
              />
            )}
            {detail && (
              <TaskCard
                detail={detail}
                patch={patch}
                workers={state.workers}
                project={
                  state.projects.find((project: Row) => project.id === detail.task.projectId)?.name
                }
                changes={openTask}
                activity={openTask}
                sources={openTask}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
