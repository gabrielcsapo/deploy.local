import { requireStateRefreshSources } from './state-refresh-sources-port.ts';
import { materialized } from '../kernel/materialized.ts';

// Time-based inbox expiry and live health without an event may wait up to two seconds
// for another refresh (getLive retains its own existing health collection cadence).
export const STATE_REFRESH_INTERVAL_MS = 2_000;
export const stateRefresh = materialized(
  async (owner: string) => {
    const { getLive, syncInbox } = await requireStateRefreshSources('state refresh')();
    await getLive(owner, false);
    syncInbox(owner, false);
  },
  { cadenceMs: STATE_REFRESH_INTERVAL_MS },
);
