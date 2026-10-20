import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Preserve explicit configuration; discover the helper embedded by the Mac app install. */
export function configureMacDesktopHelper(
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  home = homedir(),
) {
  if (platform !== 'darwin' || env.DEPLOY_DESKTOP_HELPER) return;
  const helper = [join(home, 'Applications/Deploy.app'), '/Applications/Deploy.app']
    .map((app) => join(app, 'Contents/Helpers/deploy-control-helper'))
    .find((path) => exists(path));
  if (helper) env.DEPLOY_DESKTOP_HELPER = helper;
}
