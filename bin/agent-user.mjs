import { existsSync, mkdirSync, chownSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

function loginUser(uid) {
  const result = spawnSync('getent', ['passwd', String(uid)], { encoding: 'utf8' });
  const [name, , userId, groupId, , home] = (result.stdout || '').trim().split(':');
  if (result.status !== 0 || uid <= 0 || Number(userId) !== uid || !home?.startsWith('/'))
    throw new Error(
      'Cannot identify the login user. Run task-worker setup from your normal login.',
    );
  return { uid, gid: Number(groupId), name, home };
}
/** A sudo join installs the worker into the invoking user's login, never root's. */
export function agentUser() {
  if (process.platform === 'linux' && process.getuid?.() === 0 && process.env.SUDO_UID)
    return loginUser(Number(process.env.SUDO_UID));
  return { uid: process.getuid?.(), gid: process.getgid?.(), home: homedir() };
}
/** The Linux system agent runs as root; its unit names the login that owns the task worker. */
export function taskWorkerUser() {
  if (
    process.platform === 'linux' &&
    process.getuid?.() === 0 &&
    process.env.DEPLOY_TASK_WORKER_UID
  )
    return loginUser(Number(process.env.DEPLOY_TASK_WORKER_UID));
  return agentUser();
}

export function ownUserFile(file, user = agentUser()) {
  if (process.getuid?.() === 0 && user.uid > 0) chownSync(file, user.uid, user.gid);
}
export function userDirectory(dir, user = agentUser()) {
  if (existsSync(dir)) return;
  const parent = dirname(dir);
  if (parent !== dir) userDirectory(parent, user);
  mkdirSync(dir, { mode: 0o700 });
  ownUserFile(dir, user);
}
