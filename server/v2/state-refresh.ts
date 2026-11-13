import { materialized } from '../kernel/materialized.ts';

// Time-based inbox expiry and live health without an event may wait up to two seconds
// for another refresh (getLive retains its own existing health collection cadence).
export const STATE_REFRESH_INTERVAL_MS = 2_000;
export const stateRefresh = materialized(
  async (owner: string) => {
    const { getLive } = await import('./live.ts');
    const { syncInbox } = await import('./inbox.ts');
    await getLive(owner, false);
    syncInbox(owner, false);
  },
  { cadenceMs: STATE_REFRESH_INTERVAL_MS },
);
