import { commandOutput, type VerificationRun } from './workspace-verification.ts';

type Row = Record<string, any>;

/** Where a recorded verification run ended up, with the output lines that decided it. */
export type VerificationOutcome = {
  status: 'succeeded' | 'failed' | 'unknown';
  /** The few lines read to decide, for the record; empty when nothing had to be read. */
  evidence: string;
};

/**
 * The summaries verification tools print when they finish. `counted` patterns capture a failure
 * count, where zero is a pass; the rest state the result outright. A failure anywhere in the
 * output wins: a run that reported one is failed even if another tool in the same command
 * passed, and output that says nothing at all is never read as success.
 */
const summaries: { pattern: RegExp; counted?: true; failed?: true }[] = [
  // node:test, both the spec reporter ("ℹ fail 0") and the TAP summary ("# fail 0").
  { pattern: /^[ℹ#]\s*fail\s+(\d+)\b.*$/gm, counted: true },
  // tsc and vue-tsc report every diagnostic; nothing is printed when a project is clean.
  { pattern: /^.*\berror TS\d+\b.*$/gm, failed: true },
  // oxlint and eslint diagnostics, then their problem counts. Warnings are not failures.
  { pattern: /^\S+:\d+:\d+:\s*error\b.*$/gm, failed: true },
  { pattern: /^.*✖\s*\d+\s*problems?\s*\((\d+)\s*errors?.*$/gm, counted: true },
  { pattern: /^.*\bFound\s+\d+\s+warnings?\s+and\s+(\d+)\s+errors?.*$/gm, counted: true },
  // oxfmt --check and prettier --check.
  { pattern: /^.*(?:Format|Code style) issues found.*$/gm, failed: true },
  { pattern: /^.*All matched files use (?:the correct format|Prettier code style).*$/gm },
  // swift test, under XCTest and swift-testing.
  { pattern: /^.*Executed \d+ tests?, with (?:[^,]*and )?(\d+) failures?.*$/gm, counted: true },
  { pattern: /^.*Test run with \d+ tests?.*\bfailed\b.*$/gm, failed: true },
  { pattern: /^.*Test run with \d+ tests?.*\bpassed\b.*$/gm },
  // xcodebuild.
  { pattern: /^.*\*\* (?:BUILD|TEST|ANALYZE|ARCHIVE) FAILED \*\*.*$/gm, failed: true },
  { pattern: /^.*\*\* (?:BUILD|TEST|ANALYZE|ARCHIVE) SUCCEEDED \*\*.*$/gm },
  // cargo test, then rustc and clippy diagnostics.
  { pattern: /^.*test result: FAILED\..*$/gm, failed: true },
  { pattern: /^.*test result: ok\..*$/gm },
  { pattern: /^error(?:\[E\d+\])?:.*$/gm, failed: true },
  // go test.
  { pattern: /^(?:FAIL\b|--- FAIL:).*$/gm, failed: true },
  { pattern: /^ok\s+\S+\s+(?:\(cached\)|[\d.]+m?s).*$/gm },
  // pytest's terminal summary line.
  { pattern: /^=+[^=\n]*\b\d+ (?:failed|errors?)\b.*$/gm, failed: true },
  { pattern: /^=+[^=\n]*\b\d+ passed\b.*$/gm },
  // Package runners reporting that a script itself did not finish.
  { pattern: /^.*(?:ELIFECYCLE|Command failed with exit code \d+).*$/gm, failed: true },
];

/** How many deciding lines a record keeps, and how long each one may be. */
const evidenceLines = 3;
const evidenceChars = 160;

const deciding = (lines: string[]) =>
  [...new Set(lines)]
    .slice(-evidenceLines)
    .map((line) => line.slice(0, evidenceChars))
    .join('\n');

/**
 * Read a verification run's result out of its output. `silentOnSuccess` says every tool in the
 * command prints only diagnostics, so output with no diagnostic in it is their pass; test
 * runners are not silent, and without their summary the run stays unknown. Output must exist
 * either way: a command the shell never reached says nothing about the work.
 */
export function verificationOutcome(output: string, silentOnSuccess = false): VerificationOutcome {
  const failed: string[] = [];
  const passed: string[] = [];
  for (const summary of summaries)
    for (const match of output.matchAll(summary.pattern)) {
      const line = match[0].trim();
      const count = summary.counted ? Number(match[1]) : null;
      if (summary.failed || (count ?? 0) > 0) failed.push(line);
      else if (count === null || count === 0) passed.push(line);
    }
  if (failed.length) return { status: 'failed', evidence: deciding(failed) };
  if (passed.length) return { status: 'succeeded', evidence: deciding(passed) };
  if (silentOnSuccess && output.trim()) return { status: 'succeeded', evidence: '' };
  return { status: 'unknown', evidence: '' };
}

/**
 * Where a recorded verification command ended up. An unpiped command's exit code is its result,
 * as is a piped command's under pipefail. Otherwise the exit code belongs to `tail`, so the
 * result is read from the output tail instead, and output that does not say leaves the run
 * unknown rather than passed or failed. `null` means the command reported nothing at all: an
 * interrupted command is not a result.
 */
export function verificationResult(run: VerificationRun, item: Row): VerificationOutcome | null {
  const exitCode = Number.isInteger(item.exit_code) ? (item.exit_code as number) : null;
  // A Claude tool result reports a command's failure as a flag instead of an exit code.
  const succeeded =
    exitCode != null ? exitCode === 0 : typeof item.isError === 'boolean' ? !item.isError : null;
  if (run.trustedExitCode && succeeded !== null)
    return { status: succeeded ? 'succeeded' : 'failed', evidence: '' };
  const output = commandOutput(item);
  const outcome = verificationOutcome(output, run.silentOnSuccess && succeeded !== false);
  if (outcome.status === 'unknown' && succeeded === null && !output.trim()) return null;
  // Output that reads as passing cannot outrank a shell that reported the command failed.
  if (outcome.status === 'succeeded' && succeeded === false)
    return { status: 'unknown', evidence: outcome.evidence };
  return outcome;
}
