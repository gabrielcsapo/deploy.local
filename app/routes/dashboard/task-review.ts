import { latestChecks, failedJob } from './task-activity-summary';
/** Never report success for missing output, cancelled jobs, or an unavailable patch. */
export function checkSummary(
  checks: { exitCode?: number | null }[],
  attempts: { status: string; [key: string]: any }[],
  unavailable: boolean,
): string {
  const jobs = latestChecks(attempts).map((check) => check.latest);
  if (
    checks.some((check) => check.exitCode != null && check.exitCode !== 0) ||
    jobs.some(failedJob)
  )
    return 'Failed';
  if (
    checks.some((check) => check.exitCode == null) ||
    jobs.some((job) => ['running', 'queued'].includes(job.status))
  )
    return 'In progress';
  if (unavailable) return 'Unavailable';
  if (!checks.length && !jobs.length) return 'Not recorded';
  if (
    checks.every((check) => check.exitCode === 0) &&
    jobs.every((job) => job.status === 'succeeded')
  )
    return 'Passed';
  return 'Not completed';
}
