import type {
  BackupInventorySource,
  BackupProviderId,
  BackupSchedule,
} from '../contracts/backup-provider.ts';

/** Read-only aggregation. In particular it has no restore or timer dispatch. */
export class BackupCatalog {
  readonly sources: readonly BackupInventorySource[];
  readonly schedules: () => BackupSchedule[];

  constructor(sources: readonly BackupInventorySource[], schedules: () => BackupSchedule[]) {
    this.sources = sources;
    this.schedules = schedules;
    if (new Set(sources.map((source) => source.id)).size !== sources.length)
      throw new Error('Duplicate backup provider');
  }

  async inventory() {
    return Promise.all(
      this.sources.map(async (source) => {
        const [holdings, history] = await Promise.allSettled([
          source.inventory(),
          source.history(),
        ]);
        // Availability and attempt history are independent: a removed drive can still have
        // a known failed attempt, and a malformed history must not hide existing archives.
        return {
          provider: source.id,
          scope: source.scope,
          holdings: holdings.status === 'fulfilled' ? holdings.value : undefined,
          unavailable: holdings.status === 'rejected' ? String(holdings.reason) : undefined,
          history: history.status === 'fulfilled' ? history.value : undefined,
          historyUnavailable: history.status === 'rejected' ? String(history.reason) : undefined,
        };
      }),
    );
  }

  source(id: BackupProviderId) {
    const source = this.sources.find((candidate) => candidate.id === id);
    if (!source) throw new Error(`Backup provider ${id} is not wired`);
    return source;
  }
}
