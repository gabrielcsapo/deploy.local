'use client';
import { Skeleton } from '@/components/ui';
import { IconButton, CopyButton, ActionCluster, WorkspaceIcon } from '@/components/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { TaskSources } from './task-activity.client';
import { JobArtifacts } from './job-artifacts.client';
import type { Attachment } from './attachment-state';
import {
  activeJob,
  activitySections,
  activitySummary,
  checkIdentity,
  failedJob,
  jobDuration,
  jobStatus,
  jobTitle,
  latestChecks,
  orderedJobs,
  relativeTime,
} from './task-activity-summary';
type Row = Record<string, any>;
export type ActivityFocus = {
  runId?: string;
  check?: string;
  sources?: boolean;
  key: number;
} | null;
export function JobGlyph({ job }: { job: Row }) {
  const status = jobStatus(job);
  return (
    <span className={`pw-job-glyph status-${job.status}`} aria-label={status}>
      <svg
        viewBox="0 0 20 20"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      >
        <circle cx="10" cy="10" r="8" />
        {status === 'Passed' ? (
          <path d="m5 10 3 3 7-7" />
        ) : status === 'Failed' ? (
          <path d="m7 7 6 6m0-6-6 6" />
        ) : status === 'Cancelled' ? (
          <path d="m4 16 12-12" />
        ) : status === 'Running' ? (
          <path d="M10 2a8 8 0 0 1 0 16Z" fill="currentColor" />
        ) : (
          <path d="M10 5v5l4 2" />
        )}
      </svg>
    </span>
  );
}
export function TaskActivitySummary({
  jobs = [],
  activity = [],
  open,
  selected = false,
  compact = false,
}: {
  jobs?: Row[];
  activity?: Row[];
  open: () => void;
  selected?: boolean;
  compact?: boolean;
}) {
  const summary = activitySummary(jobs, activity);
  if (!summary.visible) return null;
  const allPassed =
    jobs.length > 0 && latestChecks(jobs).every((check) => check.latest.status === 'succeeded');
  if (compact)
    return (
      <Button
        variant="link"
        className="pw-activity-summary pw-activity-chip"
        aria-label={summary.label}
        aria-pressed={selected}
        onClick={open}
      >
        {summary.running > 0 && (
          <span>
            <JobGlyph job={{ status: 'running' }} /> {summary.running} running
          </span>
        )}
        {summary.failing > 0 && (
          <span className="pw-activity-failed">
            <JobGlyph job={{ status: 'failed' }} /> {summary.failing} failing
          </span>
        )}
        {!summary.running &&
          !summary.failing &&
          (allPassed ? (
            <span>
              <JobGlyph job={{ status: 'succeeded' }} /> {summary.passed} check
              {summary.passed === 1 ? '' : 's'} passed
            </span>
          ) : (
            summary.text
          ))}
      </Button>
    );
  return (
    <Button
      variant="link"
      className="pw-activity-summary"
      aria-label={summary.label}
      aria-pressed={selected}
      onClick={open}
    >
      <span>
        {summary.failing > 0 && (
          <span className="pw-activity-failed">{summary.failing} failing · </span>
        )}
        {summary.text.replace(/^\d+ failing · /, '')}
      </span>
    </Button>
  );
}
export function JobRow({
  job,
  earlier = [],
  workers,
  busy,
  cancel,
  showConversation,
  now = Date.now(),
  turnNumber,
  runNumbers = {},
  attachments = [],
}: {
  job: Row;
  earlier?: Row[];
  workers: Row[];
  busy: boolean;
  cancel: (job: Row) => void;
  showConversation?: (runId: string) => void;
  now?: number;
  turnNumber?: number;
  runNumbers?: Record<string, number>;
  /** The task's attachment rows, for job artifact thumbnails and previews. */
  attachments?: Attachment[];
}) {
  const [wrap, setWrap] = useState(true);
  const descriptionId = useId();
  const computer =
    workers.find((w) => w.id === job.workerId)?.name ?? job.workerId ?? 'Waiting for computer';
  const failures = earlier.filter(failedJob).length;
  const error = (
    job.error ||
    String(job.output ?? '')
      .split('\n')
      .find((line) => /error|fatal|fail|exception/i.test(line)) ||
    ''
  ).trim();
  const description = failedJob(job)
    ? [job.exitCode != null && job.exitCode !== 0 ? `Exit ${job.exitCode}` : '', error]
        .filter(Boolean)
        .join(' · ')
    : job.status === 'queued' && job.waitingReason
      ? `Waiting: ${job.waitingReason}`
      : job.status === 'running'
        ? String(job.output ?? '')
            .trim()
            .split('\n')
            .at(-1)
        : '';
  const duration = jobDuration(job, now);
  return (
    <div className="pw-job-entry" data-job-id={job.id}>
      <details className="pw-job-row">
        <summary
          aria-label={`${jobTitle(job)} on ${computer}, ${jobStatus(job).toLowerCase()}${duration ? `, ${duration.replace(/(\d+)m/g, '$1 minutes').replace(/(\d+)s/g, '$1 seconds')}` : ''}`}
          aria-describedby={description ? descriptionId : undefined}
        >
          <JobGlyph job={job} />
          <span className="pw-job-title" title={jobTitle(job)}>
            {jobTitle(job)}
          </span>
          <span className="pw-job-meta">
            {[computer, duration, relativeTime(job.createdAt, now)].filter(Boolean).join(' · ')}
          </span>
          {description && (
            <span
              id={descriptionId}
              className={`pw-job-description ${failedJob(job) ? 'pw-activity-failed' : job.waitingReason ? 'pw-job-waiting' : 'pw-job-tail'}`}
            >
              {description}
            </span>
          )}
        </summary>
        <div className="pw-job-detail">
          <div className="pw-job-tools">
            <span>Command</span>
            <ActionCluster>
              <CopyButton size="compact" label="Copy command" text={job.command} />
            </ActionCluster>
          </div>
          <pre className="pw-job-command">{job.command}</pre>
          <div className="pw-job-tools">
            <span>Output</span>
            <ActionCluster>
              <CopyButton size="compact" label="Copy output" text={job.output ?? ''} />
              <IconButton
                size="compact"
                icon="wrap"
                label="Wrap output"
                className="pw-job-wrap"
                pressed={wrap}
                onClick={() => setWrap(!wrap)}
              />
            </ActionCluster>
          </div>
          <pre className="pw-job-log" data-wrap={wrap} tabIndex={0} aria-label="Job output">
            {String(job.output || (activeJob(job) ? 'No output yet.' : 'No output.'))
              .split('\n')
              .map((line, index) => (
                <span
                  key={index}
                  className={
                    /error|fatal|fail|exception/i.test(line) ? 'pw-activity-failed' : undefined
                  }
                >
                  {line}
                  {'\n'}
                </span>
              ))}
          </pre>
          {(job.truncated || job.outputTruncated) && (
            <p className="pw-muted">
              Showing the last {String(job.output ?? '').length.toLocaleString('en-US')} characters.
            </p>
          )}
          <div className="pw-job-metadata">
            {[
              job.exitCode != null && job.exitCode !== 0 ? `Exit ${job.exitCode}` : '',
              job.digest ? `checkpoint ${job.digest.slice(0, 7)}` : '',
              turnNumber ? `Turn ${turnNumber}` : '',
            ]
              .filter(Boolean)
              .join(' · ')}
            {job.runId && showConversation && (
              <IconButton
                size="compact"
                icon="jump"
                label="Show in conversation"
                onClick={() => showConversation(job.runId)}
              />
            )}
          </div>
        </div>
      </details>
      <JobArtifacts job={job} attachments={attachments} />
      {earlier.length > 0 && (
        <details className="pw-job-retries">
          <summary>
            {job.status === 'succeeded' && failures
              ? `Passed after ${failures} failure${failures === 1 ? '' : 's'}`
              : `${earlier.length} earlier attempt${earlier.length === 1 ? '' : 's'}`}
          </summary>
          {earlier.map((attempt) => (
            <JobRow
              key={attempt.id}
              job={attempt}
              workers={workers}
              busy={busy}
              cancel={cancel}
              showConversation={showConversation}
              now={now}
              turnNumber={runNumbers[attempt.runId]}
              runNumbers={runNumbers}
              attachments={attachments}
            />
          ))}
        </details>
      )}
      {activeJob(job) && (
        <Button variant="link" disabled={busy || job.stopRequested} onClick={() => cancel(job)}>
          {job.stopRequested ? 'Cancellation requested' : 'Cancel'}
        </Button>
      )}
    </div>
  );
}
export function CheckVerdicts({
  jobs,
  workers,
  open,
}: {
  jobs: Row[];
  workers: Row[];
  open: (check: string) => void;
}) {
  const checks = latestChecks(jobs);
  return (
    <>
      {[...new Set(checks.map((c) => c.latest.workerId))].map((workerId) => (
        <section className="pw-check-verdicts" key={workerId ?? 'waiting'}>
          <h3>
            {workers.find((w) => w.id === workerId)?.name ?? workerId ?? 'Waiting for computer'}
          </h3>
          {checks
            .filter((c) => c.latest.workerId === workerId)
            .map((check) => (
              <div key={check.key}>
                <JobGlyph job={check.latest} />
                <Button variant="link" onClick={() => open(check.key)}>
                  {jobTitle(check.latest)}
                </Button>
                <span>{jobStatus(check.latest)}</span>
                <span>{jobDuration(check.latest)}</span>
                {check.latest.status === 'succeeded' && check.failures > 0 && (
                  <small>
                    after {check.failures} failure{check.failures === 1 ? '' : 's'}
                  </small>
                )}
              </div>
            ))}
        </section>
      ))}
    </>
  );
}
export function TaskActivityPanel({
  detail,
  workers,
  busy,
  cancel,
  showConversation,
  focus = null,
}: {
  detail: Row | null;
  workers: Row[];
  busy: boolean;
  cancel: (job: Row) => void;
  showConversation?: (runId: string) => void;
  focus?: ActivityFocus;
}) {
  const [filter, setFilter] = useState('latest');
  const [now, setNow] = useState(Date.now);
  const [scope, setScope] = useState<ActivityFocus>(focus);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setScope(focus);
    setFilter('latest');
    if (focus?.sources) {
      const sources = root.current?.querySelector<HTMLDetailsElement>('.pw-task-sources');
      if (sources) {
        sources.open = true;
        sources.scrollIntoView({ block: 'start' });
        sources.querySelector('summary')?.focus();
      }
    } else root.current?.scrollTo({ top: 0 });
  }, [focus]);
  const jobs: Row[] = detail?.jobs ?? [];
  const counts = activitySummary(jobs);
  const checks = latestChecks(jobs);
  const selected = jobs.filter(
    (j) =>
      (scope?.runId === undefined || (j.runId ?? '') === scope.runId) &&
      (!scope?.check || checkIdentity(j) === scope.check),
  );
  const visible =
    filter === 'all'
      ? selected
      : latestChecks(selected)
          .map((c) => c.latest)
          .filter((j) => filter !== 'failed' || failedJob(j));
  const sections = activitySections(visible, detail?.runs, detail?.messages, selected);
  const nowJobs = scope || filter === 'failed' ? [] : orderedJobs(selected.filter(activeJob));
  const attentionJobs = scope ? [] : sections.attention;
  const pinned = new Set([...nowJobs, ...attentionJobs].map((j) => j.id));
  const runNumbers = Object.fromEntries(
    [...(detail?.runs ?? [])]
      .sort((a: Row, b: Row) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map((run: Row, index: number) => [run.id, index + 1]),
  );
  const questions = (detail?.questions ?? []).filter((q: Row) => q.status !== 'pending');
  const row = (job: Row, turnNumber?: number) => (
    <JobRow
      key={job.id}
      job={job}
      earlier={filter === 'all' ? [] : checks.find((c) => c.latest.id === job.id)?.earlier}
      workers={workers}
      busy={busy}
      cancel={cancel}
      showConversation={showConversation}
      now={now}
      turnNumber={turnNumber || runNumbers[job.runId]}
      runNumbers={runNumbers}
      attachments={detail?.attachments ?? []}
    />
  );
  return (
    <div className="pw-activity-panel" ref={root}>
      {!detail && <Skeleton label="Loading activity" />}
      <div className="pw-activity-counters">
        {counts.running > 0 && (
          <span>
            <JobGlyph job={{ status: 'running' }} />
            {counts.running} running
          </span>
        )}
        {counts.failing > 0 && (
          <span className="pw-activity-failed">
            <JobGlyph job={{ status: 'failed' }} />
            {counts.failing} failing
          </span>
        )}
        {counts.passed > 0 && (
          <span>
            <JobGlyph job={{ status: 'succeeded' }} />
            {counts.passed} passed
          </span>
        )}
      </div>
      <div className="pw-activity-filters" role="group" aria-label="Activity filter">
        {[
          ['latest', 'Latest'],
          ['all', 'All attempts'],
          ['failed', 'Failed'],
        ].map(([value, title]) => (
          <Button
            key={value}
            variant="quiet"
            aria-pressed={filter === value}
            onClick={() => setFilter(value!)}
          >
            {title}
          </Button>
        ))}
      </div>
      {scope && (
        <Button variant="link" onClick={() => setScope(null)}>
          Show all turns and checks
        </Button>
      )}
      {detail && !visible.length && (
        <p className="pw-muted">{jobs.length ? 'No matching jobs.' : 'No jobs yet.'}</p>
      )}
      {nowJobs.length > 0 && (
        <section aria-label="Now">
          <h3>Now</h3>
          {nowJobs.map((j) => row(j))}
        </section>
      )}
      {attentionJobs.length > 0 && (
        <section aria-label="Needs attention">
          <h3>Needs attention</h3>
          {attentionJobs.map((j) => row(j))}
        </section>
      )}
      {sections.turns.map((turn) => (
        <details
          className="pw-activity-turn"
          key={`${turn.runId}-${filter}-${scope?.key ?? ''}`}
          open={!turn.allPassed || !!scope}
        >
          <summary>
            {turn.title} · {turn.jobCount} job{turn.jobCount === 1 ? '' : 's'}
            {turn.allPassed ? ' · all passed' : ''}
          </summary>
          {turn.jobs.filter((j) => !pinned.has(j.id)).map((j) => row(j, turn.number))}
          {turn.jobs.some((j) => pinned.has(j.id)) && (
            <Button
              variant="quiet"
              onClick={() => setScope({ runId: turn.runId, key: Date.now() })}
            >
              Show all jobs in this turn <WorkspaceIcon name="chevron" />
            </Button>
          )}
        </details>
      ))}
      <TaskSources
        activity={detail?.activity ?? []}
        roots={[detail?.task?.workspacePath, detail?.task?.remoteWorkspacePath].filter(Boolean)}
      />
      {questions.length > 0 && (
        <section aria-label="Questions and answers">
          <h3>Questions and answers</h3>
          {questions.map((q: Row) => (
            <div key={q.id}>
              <p>{q.question}</p>
              <p className="pw-muted">{q.answer || q.status}</p>
            </div>
          ))}
        </section>
      )}
      {!!detail?.events?.length && (
        <details className="pw-task-activity">
          <summary>Raw events</summary>
          <CopyButton
            size="compact"
            label="Copy JSON"
            text={JSON.stringify(detail.events, null, 2)}
          />
          {detail.eventsTruncated && (
            <p className="pw-muted">Showing the {detail.events.length} most recent events.</p>
          )}
          {detail.events.map((event: Row) => (
            <details key={event.cursor}>
              <summary>{event.type}</summary>
              <pre className="pw-job-log" data-wrap="true">
                {JSON.stringify(event.payload, null, 2)}
              </pre>
            </details>
          ))}
        </details>
      )}
    </div>
  );
}
