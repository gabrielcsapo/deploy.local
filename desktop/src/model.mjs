export function liveLabel(summary) {
  if (!summary || !Number.isFinite(summary.running)) return 'Unavailable';
  return `${summary.running} running${summary.failing ? ` · ${summary.failing} failing` : ''}`;
}
export class InboxModel {
  items = new Map();
  seen = new Set();
  cursor = null;
  replace(items) {
    this.items = new Map(items.map((item) => [item.id, item]));
    return this.newWaiting(items);
  }
  newWaiting(items) {
    const fresh = items.filter((item) => item.state === 'waiting' && !this.seen.has(item.id));
    for (const item of items) this.seen.add(item.id);
    return fresh;
  }
  apply(page) {
    const changed = [];
    for (const event of page.events)
      if (event.type === 'inbox') {
        this.items.set(event.item.id, event.item);
        changed.push(event.item);
      }
    this.cursor = page.cursor;
    return this.newWaiting(changed);
  }
  waiting() {
    return [...this.items.values()].filter((item) => item.state === 'waiting');
  }
}
export function relativeTime(at, now = Date.now()) {
  const elapsed = Math.max(0, now - Date.parse(at));
  if (!Number.isFinite(elapsed)) return 'Unavailable';
  if (elapsed < 60000) return 'now';
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)}m`;
  if (elapsed < 86400000) return `${Math.floor(elapsed / 3600000)}h`;
  return `${Math.floor(elapsed / 86400000)}d`;
}
export function trayModel({
  online,
  summary,
  live,
  inbox = [],
  worker,
  computers,
  workerId,
  now,
  appWorker,
}) {
  summary = live?.summary || summary;
  const computer = computers?.find((entry) => entry.workerIds.includes(workerId));
  const coordinator = computers?.find((entry) => entry.roles.includes('coordinator'));
  const apps = (live?.computers || [])
    .flatMap((entry) => entry.apps)
    .filter((entry) => ['failing', 'warning'].includes(entry.state))
    .sort((a, b) => Number(b.state === 'failing') - Number(a.state === 'failing'));
  return {
    connection: online ? 'Connected' : 'Offline · retrying every 10 s',
    count: inbox.length,
    live: liveLabel(summary),
    failing:
      Number(summary?.failing || 0) > 0 ||
      !!(appWorker?.install !== 'none' && appWorker?.state && appWorker.state !== 'running'),
    icon:
      appWorker?.install !== 'none' && appWorker?.state && appWorker.state !== 'running'
        ? 'failing'
        : !online
          ? 'offline'
          : summary?.failing
            ? 'failing'
            : summary?.warning
              ? 'warning'
              : 'connected',
    running: Number.isFinite(summary?.running) ? `${summary.running} running` : 'Unavailable',
    coordinator: coordinator?.name,
    computersOnline: computers?.filter((entry) => entry.online).length,
    computer,
    apps: apps.map((entry) => ({
      ...entry,
      label:
        entry.state === 'failing'
          ? 'Failing'
          : /(?:memory\s+\d+(?:\.\d+)?%|\d+(?:\.\d+)?% of memory in use)/i.test(entry.summary)
            ? 'High memory'
            : 'Warning',
    })),
    items: inbox.map((item) => ({
      id: item.id,
      title: item.title,
      from: item.from,
      text: item.text,
      time: relativeTime(item.createdAt, now),
      createdAt: item.createdAt,
      actions: item.actions,
    })),
    worker,
  };
}
export function externalUrl(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Only web addresses can be opened.');
  return url.href;
}
export function roles(value, platform = process.platform, helper = false) {
  const result = Object.fromEntries(
    ['takeTasks', 'runApps', 'serveModels', 'useScreen'].map((key) => [key, value?.[key] === true]),
  );
  if (result.runApps && platform !== 'darwin')
    throw new Error('Run apps is not supported here yet.');
  if (result.serveModels)
    throw new Error(
      'Run apps and Serve models need runtime setup on this computer. The coordinator does not support changing them yet.',
    );
  if (result.useScreen && (platform !== 'darwin' || !helper))
    throw new Error(
      'Use the screen needs the macOS control helper. It is not supported on Windows or Linux yet.',
    );
  if (result.useScreen && !result.takeTasks)
    throw new Error('Turn on Take tasks before Use the screen.');
  return result;
}
