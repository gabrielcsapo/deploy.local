// Local entry point for the coordinator installer. Never exposed over HTTP.
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { issueSetupCode, serverIdentity, hasOwner } from './setup.ts';

export async function finishInstall(
  mode: 'fresh' | 'recover',
  recovery?: { bundlePath: string; passphrase: string; destinationDataDirectory: string },
) {
  if (mode === 'recover') {
    if (!recovery)
      throw new Error('Recovery needs a bundle, passphrase and empty replacement data directory.');
    const { restoreRecoveryBundle } = await import('../recovery-bundle.ts');
    const result = restoreRecoveryBundle(recovery);
    writeFileSync(
      resolve(recovery.destinationDataDirectory, 'v2-recovery.json'),
      JSON.stringify({
        state: 'restored',
        summary:
          'Account, projects, agents and secrets restored from the recovery bundle. Start the replacement coordinator to check app data and reconnect computers.',
        projects: [],
        restoredAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    return { ...result, follow: 'https://deploy.local/recover' };
  }
  if (hasOwner()) throw new Error('An account already exists. Sign in with your password.');
  const { ensureCerts } = await import('../certs.ts');
  ensureCerts();
  const result = issueSetupCode();
  return { ...result, ...serverIdentity(), follow: `${serverIdentity().origin}/setup` };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const choice = await prompt.question('Start fresh, or recover from a backup? [f/r] ');
    if (choice.trim().toLowerCase() === 'r') {
      const [bundlePath, destinationDataDirectory] = process.argv.slice(2);
      const passphrase = process.env.DEPLOY_RECOVERY_PASSPHRASE;
      if (!bundlePath || !destinationDataDirectory || !passphrase)
        throw new Error(
          'Pass a bundle path and an empty replacement data directory, and set DEPLOY_RECOVERY_PASSPHRASE.',
        );
      console.log(
        await finishInstall('recover', { bundlePath, destinationDataDirectory, passphrase }),
      );
    } else if (choice.trim().toLowerCase() === 'f' || !choice.trim()) {
      const result = await finishInstall('fresh');
      console.log('SER is ready. Finish setup from any computer at home:');
      console.log(JSON.stringify(result, null, 2));
    } else throw new Error('Choose f or r.');
  } finally {
    prompt.close();
  }
}
