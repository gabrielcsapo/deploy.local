import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Shared by the logged-in user's tray and task worker; never use a coordinator-side flag. */
export function controlPausePath(env = process.env, home = homedir()) {
  return (
    env.DEPLOY_CONTROL_PAUSE_FILE ||
    join(env.XDG_STATE_HOME || join(home, '.local/state'), 'deploy/control-paused')
  );
}
export function controlPaused(path = controlPausePath()) {
  return existsSync(path);
}
export function setControlPaused(paused: boolean, path = controlPausePath()) {
  if (paused) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, 'paused\n', { mode: 0o600 });
  } else rmSync(path, { force: true });
}
