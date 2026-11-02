export type RepositoryCommit = { oid: string; author: string; date: string; subject: string };
export function repositoryTime(value?: string, now = Date.now()) {
  const time = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return 'Unavailable';
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return 'just now';
  for (const [unit, duration] of [
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ] as const) {
    if (seconds >= duration) {
      const count = Math.floor(seconds / duration);
      return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}
export function sourceLines(content: string) {
  if (!content) return [];
  return content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
}
export function fileSize(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export function sourceMarkdown(file: string, content: string) {
  const extension = file.split('.').at(-1)?.toLowerCase() || '';
  const languages: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    json: 'json',
    css: 'css',
    html: 'xml',
    md: 'markdown',
    py: 'python',
    sh: 'bash',
    yaml: 'yaml',
    yml: 'yaml',
  };
  const fence = '`'.repeat(
    Array.from(content.matchAll(/`+/g)).reduce(
      (longest, match) => Math.max(longest, match[0].length + 1),
      3,
    ),
  );
  return `${fence}${languages[extension] || 'text'}\n${sourceLines(content).join('\n')}\n${fence}`;
}
