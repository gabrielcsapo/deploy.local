import type { LiveApp, Release } from '../../../../../shared/v2/contracts';
import { formatTime } from '../data/time.ts';

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
    return 'Open an app for its health, releases, logs and settings.';
  const ref = app.source?.gitRef || app.source?.ref;
  return `Release ${releaseLabel(app.release, app.source)}${repository ? ` from ${repository}` : ''}${ref ? ` on ${ref}` : ''}${app.releasedAt ? `, shipped ${formatTime(app.releasedAt, 'clock')}` : ''}. Open an app for its health, releases, logs and settings.`;
}

/** Aggregate the existing Live states; no runtime checks or independent health model. */
export function projectHealth(apps: Pick<LiveApp, 'state' | 'summary'>[]) {
  if (!apps.length) return undefined;
  const failing = apps.filter((app) => app.state === 'failing').length;
  if (failing) return { kind: 'failed' as const, label: `${failing} failing` };
  const warning = apps.find((app) => app.state === 'warning');
  if (warning) return { kind: 'attention' as const, label: appHealthLabel(warning) };
  if (apps.every((app) => app.state === 'stopped'))
    return { kind: 'inactive' as const, label: 'Not running' };
  return { kind: 'healthy' as const, label: 'Healthy' };
}

export function appHealthLabel(app: Pick<LiveApp, 'state' | 'summary'>) {
  if (app.state === 'warning') {
    if (/memory|% of \d+(?:\.\d+)? GB/i.test(app.summary)) return 'High memory';
    if (app.summary.includes('baseline')) return 'Learning baseline';
    if (app.summary.includes('overdue')) return 'Report overdue';
    if (app.summary.includes('waiting')) return 'Queue delayed';
    return 'Checks unavailable';
  }
  return { healthy: 'Healthy', failing: 'Failing', stopped: 'Stopped' }[app.state];
}
