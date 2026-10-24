export interface TaskFileReference {
  path: string;
  line?: number;
}

export interface TaskFileContext {
  id: string;
  workspacePath?: string | null;
  remoteWorkspacePath?: string | null;
}

/**
 * Agents link files as absolute worker paths, often with a line (`/…/tasks/<id>/web/a.mjs:12`).
 * Map any link inside the task workspace to its repository-relative path; external links,
 * anchors and paths outside the workspace return null and keep their normal behaviour.
 */
export function taskFileReference(
  href: string | null | undefined,
  task: TaskFileContext,
): TaskFileReference | null {
  let value = (href || '').trim();
  if (!value || value.startsWith('#') || value.startsWith('?') || value.startsWith('//'))
    return null;
  if (/^file:\/\//i.test(value)) value = value.replace(/^file:\/\/(?:localhost)?/i, '');
  else if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  try {
    value = decodeURI(value);
  } catch {
    /* Keep the link text as written. */
  }
  let line: number | undefined;
  const anchor = value.match(/#L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/);
  const suffix = anchor ? null : value.match(/:(\d+)(?::\d+)?(?:-\d+)?$/);
  if (anchor || suffix) {
    line = Number((anchor || suffix)![1]);
    value = value.slice(0, (anchor || suffix)!.index);
  }
  value = value.replace(/[?#].*$/, '');
  let relative: string | null = null;
  if (value.startsWith('/')) {
    for (const root of [task.workspacePath, task.remoteWorkspacePath]) {
      const prefix = root ? root.replace(/\/+$/, '') + '/' : '';
      if (prefix && value.startsWith(prefix)) {
        relative = value.slice(prefix.length);
        break;
      }
    }
    // Workers keep each task in `<worker root>/tasks/<taskId>`; the task id is unique.
    const marker = `/tasks/${task.id}/`;
    if (relative === null && value.includes(marker))
      relative = value.slice(value.indexOf(marker) + marker.length);
  } else relative = value;
  if (relative === null) return null;
  relative = relative.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  const parts = relative.split('/');
  if (!relative || parts.some((part) => !part || part === '.' || part === '..')) return null;
  return line && line > 0 ? { path: relative, line } : { path: relative };
}

// Paths the dashboard itself serves; any other absolute path is on some computer's disk.
const appRoute = /^\/(?:dashboard|api|docs|discover|changelog)(?:[/?#]|$)/;

/**
 * A link to a file on a computer's disk (`file://…` or an absolute path that is not a dashboard
 * route). Browsers cannot open these, so links that are not inside the task render as code.
 */
export function isLocalFilePath(href: string | null | undefined): boolean {
  const value = (href || '').trim();
  if (/^file:\/\//i.test(value)) return true;
  return value.startsWith('/') && !value.startsWith('//') && !appRoute.test(value);
}
