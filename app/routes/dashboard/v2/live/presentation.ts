/** Keep the most recent error and its following stack lines from a bounded log tail. */
export function latestError(logs: string) {
  // Terminal color escapes are intentionally stripped from log excerpts.
  // eslint-disable-next-line no-control-regex
  const lines = logs.replace(/\u001b\[[0-9;]*m/g, '').split('\n');
  const index = lines.findLastIndex((line) => /\b(error|fatal|exception|panic)\b/i.test(line));
  return index < 0
    ? ''
    : lines
        .slice(index, index + 6)
        .join('\n')
        .trim();
}
