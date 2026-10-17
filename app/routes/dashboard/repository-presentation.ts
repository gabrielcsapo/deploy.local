/** Resolve Markdown paths within the current repository, without allowing a root escape. */
export function repositoryLink(href: string, filePath: string) {
  if (!href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//'))
    return null;
  const [pathname, fragment = ''] = href.split('#');
  const parts = pathname.startsWith('/') ? [] : filePath.split('/').slice(0, -1);
  try {
    for (const part of decodeURIComponent(pathname.split('?')[0]).split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!parts.length) return null;
        parts.pop();
      } else if ([...part].some((character) => character.charCodeAt(0) < 32 || character === '\\'))
        return null;
      else parts.push(part);
    }
    return { path: parts.join('/'), fragment };
  } catch {
    return null;
  }
}
export function repositoryLanguage(path: string) {
  const extension = path.split('.').pop()?.toLowerCase();
  return (
    (
      {
        ts: 'typescript',
        tsx: 'typescript',
        js: 'javascript',
        jsx: 'javascript',
        mjs: 'javascript',
        json: 'json',
        css: 'css',
        swift: 'swift',
        py: 'python',
        yaml: 'yaml',
        yml: 'yaml',
        sh: 'bash',
        html: 'xml',
        sql: 'sql',
        md: 'markdown',
      } as Record<string, string>
    )[extension || ''] || (path.split('/').pop() === 'Dockerfile' ? 'dockerfile' : 'text')
  );
}
export function relativeCommitTime(date: string) {
  const seconds = (Date.parse(date) - Date.now()) / 1000;
  if (!Number.isFinite(seconds)) return 'Unavailable';
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, length] of [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ] as const) {
    if (Math.abs(seconds) >= length) return format.format(Math.round(seconds / length), unit);
  }
  return 'just now';
}
