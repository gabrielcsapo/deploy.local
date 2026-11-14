import { registerStateRefreshSources } from '../v2/state-refresh-sources-port.ts';

export function wireStateRefreshSources() {
  registerStateRefreshSources(async () => {
    const { getLive } = await import('../v2/live.ts');
    const { syncInbox } = await import('../v2/inbox.ts');
    return { getLive, syncInbox };
  });
}
