'use client';
import { useEffect, useState } from 'react';
import { ActionCluster, IconButton, OverflowMenu, Button } from '@/components/ui';
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
            <header className="ds-chrome-title">
              <strong>{detail?.task.title ?? 'Select a task'}</strong>
              <ActionCluster>
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
              </ActionCluster>
            </header>
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
