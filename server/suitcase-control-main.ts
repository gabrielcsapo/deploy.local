import {
  publicSuitcaseMembership,
  queueSuitcaseCommandCandidate,
  readSuitcaseMembership,
  setSuitcaseMode,
  suitcaseClientSyncStatus,
  withSuitcaseMembershipLock,
} from '../lib/suitcase-sync-client.ts';
import {
  initializeSuitcaseRuntime,
  materializeSuitcaseRuntime,
  syncSuitcaseRuntimeNow,
} from './suitcase-runtime.ts';

const membershipFile = process.env.DEPLOY_SUITCASE_MEMBERSHIP_FILE;
if (!membershipFile) throw new Error('Suitcase membership state path is unavailable');
initializeSuitcaseRuntime();
const action = process.argv[2];
const args = process.argv.slice(3);

let result: unknown;
if (action === 'status') {
  result = await suitcaseClientSyncStatus({ membershipFile });
} else if (action === 'sync') {
  const sync = await syncSuitcaseRuntimeNow(true);
  const membership = readSuitcaseMembership(undefined, membershipFile)!;
  result = { ...sync, materialization: await materializeSuitcaseRuntime(membership) };
} else if (action === 'mode') {
  const mode = args[0];
  if (mode !== 'docked' && mode !== 'away' && mode !== 'rejoining') {
    throw new Error('Core control mode must be docked, away, or rejoining');
  }
  result = await withSuitcaseMembershipLock(membershipFile, () =>
    setSuitcaseMode(mode, { membershipFile }),
  );
} else if (action === 'candidate') {
  const [appId, command] = args;
  if (!appId || !command) throw new Error('Core control candidate requires app id and command');
  result = await withSuitcaseMembershipLock(membershipFile, () =>
    queueSuitcaseCommandCandidate({ appId, command }, { membershipFile }),
  );
} else if (action === 'membership') {
  const membership = readSuitcaseMembership(undefined, membershipFile);
  result = membership ? publicSuitcaseMembership(membership) : null;
} else {
  throw new Error('Unknown suitcase core control action');
}

process.stdout.write(`${JSON.stringify(result)}\n`);
