/** Never report success for missing output, cancelled jobs, or an unavailable patch. */
export function checkSummary(
  checks: { exitCode?: number | null }[],
  jobs: { status: string }[],
  unavailable: boolean,
): string {
  if (
    checks.some((check) => check.exitCode != null && check.exitCode !== 0) ||
    jobs.some((job) => job.status === 'failed')
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
