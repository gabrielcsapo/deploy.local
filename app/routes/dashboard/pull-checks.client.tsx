'use client';
import {
  checkRuns,
  earlierAttemptsLabel,
  earlierRunsLabel,
  noHeadChecksMessage,
} from '../../../shared/check-attempts';
type Row = Record<string, any>;

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
    (run) => run.commit,
    (run) => run.commit === headCommit,
  );
  return (
    <>
      {current.length ? (
        current.map(({ latest, earlier: attempts }) => (
          <p key={latest.id} className="pw-muted">
            Check {String(latest.commit).slice(0, 7)} · {latest.status}
            {attempts.length ? ` · ${earlierAttemptsLabel(attempts.length)}` : ''}
          </p>
        ))
      ) : (
        <p className="pw-muted">{noHeadChecksMessage}.</p>
      )}
      {earlier.length > 0 && (
        <details className="ph-diff">
          <summary className="pw-muted">{earlierRunsLabel(earlier.length)}</summary>
          {earlier.map((run) => (
            <p key={run.id} className="pw-muted">
              {String(run.commit).slice(0, 7)} · {run.status}
            </p>
          ))}
        </details>
      )}
    </>
  );
}
