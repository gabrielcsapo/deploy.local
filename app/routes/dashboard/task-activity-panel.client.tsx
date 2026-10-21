'use client';
import { useEffect, useState } from 'react';
import { Button, StatusBadge } from '@/components/ui';
import { WorkspaceIcon } from './workspace-icon';
import { TaskActivity, TaskSources } from './task-activity.client';
import { activitySources, activitySummary, orderedJobs } from './task-activity-summary';

type Row = Record<string, any>;

export function TaskActivitySummary({
  jobs = [],
  activity = [],
  open,
}: {
  jobs?: Row[];
  activity?: Row[];
  open: () => void;
}) {
  const summary = activitySummary(jobs, activity);
  if (!summary.visible) return null;
  return (
    <Button
      variant="link"
      className="pw-activity-summary"
      aria-label={summary.label}
      onClick={open}
    >
      <WorkspaceIcon name="terminal" />
      {summary.running > 0 && <span className="pw-dot running" aria-hidden="true" />}
      <span>{summary.text}</span>
      <WorkspaceIcon name="chevron" />
    </Button>
  );
}

function JobAge({ createdAt }: { createdAt: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - Date.parse(createdAt)) / 1000));
  if (!Number.isFinite(seconds)) return null;
  return (
    <small title="Elapsed since queued">
      {Math.floor(seconds / 60)}m {seconds % 60}s since queued
    </small>
  );
}

export function TaskActivityPanel({
  detail,
  workers,
  busy,
  cancel,
}: {
  detail: Row | null;
  workers: Row[];
  busy: boolean;
  cancel: (job: Row) => void;
}) {
  const jobs = orderedJobs<Row>(detail?.jobs ?? []);
  const activity = detail?.activity ?? [];
  const questions = (detail?.questions ?? []).filter(
    (question: Row) => question.status !== 'pending',
  );
  return (
    <div className="pw-activity-panel">
      <section aria-label="Processes">
        <h3>Processes</h3>
        {!jobs.length && <p className="pw-muted">No processes yet.</p>}
        {jobs.map((job) => (
          <details className="pw-job pw-process-row" key={job.id}>
            <summary>
              <span className="pw-process-heading">
                <span>
                  {workers.find((worker) => worker.id === job.workerId)?.name ||
                    job.workerId ||
                    'Waiting for computer'}
                </span>
                <StatusBadge
                  tone={
                    ['running', 'queued'].includes(job.status)
                      ? 'active'
                      : job.status === 'failed'
                        ? 'failed'
                        : job.status === 'succeeded'
                          ? 'healthy'
                          : 'inactive'
                  }
                  label={
                    job.stopRequested && job.status === 'running'
                      ? 'Stopping…'
                      : job.status.replaceAll('_', ' ')
                  }
                />
              </span>
              <code title={job.command}>{job.command}</code>
              {job.exitCode != null ? (
                <small>Exit {job.exitCode}</small>
              ) : ['running', 'queued'].includes(job.status) && job.createdAt ? (
                <JobAge createdAt={job.createdAt} />
              ) : null}
              <WorkspaceIcon name="chevron-down" />
            </summary>
            <p className="pw-muted">Checkpoint {job.digest.slice(0, 12)}</p>
            {job.waitingReason && <p className="pw-muted">{job.waitingReason}</p>}
            {job.output ? <pre>{job.output}</pre> : <p className="pw-muted">No output yet.</p>}
            {job.truncated && <p className="pw-muted">Showing the last 64,000 characters.</p>}
            {job.error && <p role="alert">{job.error}</p>}
            {['queued', 'running'].includes(job.status) && (
              <Button
                variant="link"
                disabled={busy || job.stopRequested}
                onClick={() => cancel(job)}
              >
                {job.stopRequested ? 'Cancellation requested' : 'Cancel job'}
              </Button>
            )}
          </details>
        ))}
      </section>
      <section aria-label="Sources">
        <h3>Sources</h3>
        {activitySources(activity).length ? (
          <TaskSources activity={activity} expanded />
        ) : (
          <p className="pw-muted">No sources yet.</p>
        )}
      </section>
      <section aria-label="Questions and answers">
        <h3>Questions and answers</h3>
        {!questions.length && <p className="pw-muted">No answered questions yet.</p>}
        {questions.map((question: Row) => (
          <div key={question.id}>
            <p>{question.question}</p>
            <p className="pw-muted">{question.answer || question.status}</p>
          </div>
        ))}
      </section>
      <section aria-label="Agent activity">
        <h3>Agent activity</h3>
        {!activity.some((turn: Row) => turn.items.length) && (
          <p className="pw-muted">No agent activity yet.</p>
        )}
        {activity.map((turn: Row) => (
          <TaskActivity key={turn.id} activity={turn} />
        ))}
      </section>
      <details className="pw-task-activity">
        <summary>Technical event log</summary>
        {!detail?.events?.length && <p className="pw-muted">No events yet.</p>}
        {detail?.events?.slice(-60).map((event: Row) => (
          <details key={event.cursor}>
            <summary className="pw-muted">{event.type}</summary>
            <dl className="pw-event-fields">
              {Object.entries(event.payload || {})
                .filter(([key]) => !['operationId', 'taskId', 'runId'].includes(key))
                .map(([key, value]) => (
                  <div key={key}>
                    <dt>{key.replace(/([A-Z])/g, ' $1')}</dt>
                    <dd>
                      {typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}
                    </dd>
                  </div>
                ))}
            </dl>
          </details>
        ))}
      </details>
    </div>
  );
}
