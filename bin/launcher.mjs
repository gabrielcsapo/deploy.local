import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { atomicJson, readCurrentBundle, verifiedBundle } from './code-bundle.mjs';
import { LAUNCHER_PROTOCOL } from './launcher-protocol.mjs';

// Kept deliberately independent of application imports: this executes before any worker code.
export function launcherAgentDir(env = process.env, platform = process.platform, home = homedir()) {
  if (env.DEPLOY_AGENT_CONFIG) return dirname(resolve(env.DEPLOY_AGENT_CONFIG));
  if (platform === 'darwin') return join(home, 'Library/Application Support/deploy.local');
  const user = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'deploy.local');
  return existsSync(join(user, 'agent.json')) ? user : '/var/lib/deploy.local';
}
/**
 * Only a worker's own executables run an installed bundle. The same build is also the `deploy`
 * command a person types; that one always runs the code it was built with, so installing a
 * worker on a computer never changes what the command line does there.
 */
export function launcherEligible(filename, env = process.env) {
  if (env.DEPLOY_WORKER_CHILD) return true;
  return /^(deploy-)?worker(-supervisor)?(\.exe)?$/.test(basename(filename));
}
export async function runLauncher({
  build,
  baked,
  agentDir = launcherAgentDir(),
  dataDir = process.env.DEPLOY_DATA_DIR || join(agentDir, 'data'),
  filename = process.execPath,
  eligible = launcherEligible(filename),
  load = (file) => createRequire(file)(file),
}) {
  globalThis.deployLauncherBuild = { ...build, launcherProtocol: LAUNCHER_PROTOCOL };
  if (!eligible) return baked(filename, dirname(filename));
  let reason, run;
  try {
    const pointer = readCurrentBundle(agentDir);
    if (!pointer) throw new Error('No installed code bundle');
    const file = verifiedBundle(agentDir, pointer, LAUNCHER_PROTOCOL);
    // Absolute createRequire works inside SEA, whose built-in require cannot load disk modules.
    run = load(file);
    if (typeof run !== 'function') throw new Error('Bundle does not export its entry function');
  } catch (error) {
    reason = String(error.message || error).slice(0, 1000);
  }
  // Fall back only when the bundle could not be loaded. Once its entry has been called it may
  // have done work, so an error from it is the program's error, never a reason to run twice.
  // argv remains exactly as the launcher received it (including SEA's argv[1]).
  if (run) return run(filename, dirname(filename));
  try {
    atomicJson(join(dataDir, 'code-bundle.json'), {
      state: 'fallback',
      reason,
      executableVersion: build.version,
      at: Date.now(),
    });
  } catch {
    /* Read-only installations must still start. */
  }
  await baked(filename, dirname(filename));
}
