import { runSuitcaseSyncLoop } from '../lib/suitcase-sync-loop.ts';
import {
  initializeSuitcaseRuntime,
  materializeSuitcaseRuntime,
  syncSuitcaseRuntimeNow,
} from './suitcase-runtime.ts';

const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => controller.abort());
}

await runSuitcaseSyncLoop({
  membershipFile: process.env.DEPLOY_SUITCASE_MEMBERSHIP_FILE,
  signal: controller.signal,
  prepareMembership() {
    initializeSuitcaseRuntime();
  },
  sync: () => syncSuitcaseRuntimeNow(false),
  async afterSync(membership) {
    await materializeSuitcaseRuntime(membership);
  },
  onError(error, retryInMs) {
    console.warn(
      `[suitcase-sync] ${error instanceof Error ? error.message : String(error)}; retrying in ${retryInMs}ms`,
    );
  },
});
