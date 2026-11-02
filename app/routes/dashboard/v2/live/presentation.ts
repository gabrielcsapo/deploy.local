import type { LiveApp, Release } from '../../../../../shared/v2/contracts';
import { formatTime } from '../data/time';

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

export function releaseLabel(id?: string, source?: Release['source']) {
  return source?.commit ? source.commit.slice(0, 7) : id || 'Unavailable';
}

export function repositoryName(source?: { url?: string; path?: string; location?: string }) {
  const location = source?.url || source?.location || source?.path;
  if (!location) return undefined;
  const remote = location.match(
    /^(?:https?:\/\/[^/]+\/|ssh:\/\/(?:[^@/]+@)?[^/]+\/|[^@/]+@[^:]+:)(.+)$/,
  );
  return (
    remote ? remote[1].split(/[?#]/)[0] : location.split('/').filter(Boolean).at(-1)
  )?.replace(/\.git\/?$/, '');
}

export function appAddress(app: LiveApp) {
  return app.address?.replace(/^https?:\/\//, '') || 'no address';
}

export function runningSubtitle(apps: LiveApp[], repository?: string) {
  const app = apps[0];
  if (!app?.release || apps.some((entry) => entry.release !== app.release))
    return 'Open an app for its health on Live.';
  const ref = app.source?.gitRef || app.source?.ref;
  return `Release ${releaseLabel(app.release, app.source)}${repository ? ` from ${repository}` : ''}${ref ? ` on ${ref}` : ''}${app.releasedAt ? `, shipped ${formatTime(app.releasedAt, 'clock')}` : ''}. Open an app for its health on Live.`;
}
