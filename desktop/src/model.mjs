export function liveLabel(summary) {
  if (!summary || !Number.isFinite(summary.running)) return 'Unavailable';
  return `${summary.running} running${summary.failing ? ` · ${summary.failing} failing` : ''}`;
}
export class InboxModel {
  items = new Map();
  seen = new Set();
  cursor = 0;
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
export function trayModel({ online, summary, inbox, worker }) {
  return {
    connection: online ? 'Connected' : 'Offline · retrying every 10 s',
    count: inbox.length,
    live: liveLabel(summary),
    failing: Number(summary?.failing || 0) > 0,
    items: inbox.map((item) => ({
      id: item.id,
      title: item.title,
      from: item.from,
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
  if (result.runApps || result.serveModels)
    throw new Error(
      'Run apps and Serve models are not available through the workspace worker yet.',
    );
  if (result.useScreen && (platform !== 'darwin' || !helper))
    throw new Error(
      'Use the screen needs the macOS control helper. It is not supported on Windows or Linux yet.',
    );
  if (result.useScreen && !result.takeTasks)
    throw new Error('Turn on Take tasks before Use the screen.');
  return result;
}
