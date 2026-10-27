'use client';
import {
  checkRuns,
  earlierAttemptsLabel,
  earlierRunsLabel,
  noHeadChecksMessage,
  resultUnreadable,
  unknownResultMessage,
} from '../../../shared/check-attempts';
import { checkCommandLabel, checkCommandText } from '../../../shared/check-label';
type Row = Record<string, any>;

/** A run reads as passed or failed only when it said so; a piped command whose output did not
 * say reports that instead. */
const resultLabel = (run: Row) =>
  resultUnreadable(run)
    ? unknownResultMessage
    : run.status === 'succeeded'
      ? 'Passed'
      : run.status === 'failed'
        ? 'Failed'
        : run.status;

/** What a check is called here: the headline the coordinator recorded, or one derived from the
 * command for runs published before it recorded one. The command itself is kept below. */
const headline = (run: Row) =>
  String(run.label ?? '').trim() || checkCommandLabel(run.command) || String(run.command ?? '');

/** One recorded run: its headline and result on one line, with the command it ran behind a
 * tooltip and a disclosure, so the plumbing stays readable without leading the line. */
function CheckRun({ run, suffix, current }: { run: Row; suffix?: string; current?: boolean }) {
  const label = headline(run);
  // Runs published before the coordinator rewrote worker paths are cleaned here as well, so no
  // surface of this panel can show one computer's private directory layout.
  const command = checkCommandText(run.command).trim();
  // A pipeline run has no command of its own; the commit it checked names it.
  const pipeline = `${current ? 'Check ' : ''}${String(run.commit).slice(0, 7)} · ${run.status}`;
  return (
    <>
      <p className="pw-muted" title={command || undefined}>
        {run.source ? `${label} · ${resultLabel(run)}` : pipeline}
        {run.sourceLabel ? ` · ${run.sourceLabel}` : ''}
        {suffix ? ` · ${suffix}` : ''}
      </p>
      {run.source && command && command !== label && (
        <details className="ph-diff">
          <summary className="pw-muted">Command</summary>
          <code>{command}</code>
        </details>
      )}
    </>
  );
}

/**
 * A pull request's checks are the runs on its head commit: that is the version a reviewer would
 * merge. Runs on earlier commits are kept with their results, under a count, and never read as
 * where the change stands — a failure that a later commit fixed is history.
 */
export function PullChecks({ runs, headCommit }: { runs: Row[]; headCommit?: string }) {
  if (!runs.length) return null;
  // Until the comparison loads, this client does not know which commit is the head.
  if (!headCommit) return <p className="pw-muted">Placing {runs.length} recorded check run(s)…</p>;
  const { current, earlier } = checkRuns<Row>(
    runs,
    // Attempts that differ only in their plumbing are one check, so they group by headline.
    (run) =>
      run.source ? JSON.stringify([run.source, headline(run), run.sourceLabel]) : run.commit,
    (run) => run.commit === headCommit,
  );
  return (
    <>
      {current.length ? (
        current.map(({ latest, earlier: attempts }) => (
          <CheckRun
            key={latest.id}
            run={latest}
            current
            suffix={
              attempts.length + (latest.attempts ?? 1) - 1
                ? earlierAttemptsLabel(attempts.length + (latest.attempts ?? 1) - 1)
                : undefined
            }
          />
        ))
      ) : (
        <p className="pw-muted">{noHeadChecksMessage}.</p>
      )}
      {earlier.length > 0 && (
        <details className="ph-diff">
          <summary className="pw-muted">{earlierRunsLabel(earlier.length)}</summary>
          {earlier.map((run) => (
            <CheckRun key={run.id} run={run} />
          ))}
        </details>
      )}
    </>
  );
}
