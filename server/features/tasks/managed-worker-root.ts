import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { userInfo } from 'node:os';

export function workerIdentity() {
  const current = userInfo();
  if (current.uid !== 0) return current;
  // The installed updater's root-owned configuration explicitly names the ordinary operator.
  const path = '/etc/deploy-local-release.json',
    stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022)
    throw new Error('Worker operator configuration is not trusted');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(config.user)) throw new Error('Invalid worker operator');
  const fields = execFileSync('getent', ['passwd', config.user], { encoding: 'utf8' })
    .trim()
    .split(':');
  if (fields.length !== 7 || !Number(fields[2]) || !fields[5].startsWith('/'))
    throw new Error('An ordinary worker account is required');
  return {
    username: fields[0],
    uid: Number(fields[2]),
    gid: Number(fields[3]),
    homedir: fields[5],
    shell: fields[6],
  };
}
/** Where the account's managed worker keeps its state and task workspaces (`<root>/tasks/<id>`). */
export function managedWorkerRoot(workerId: string, homedir = workerIdentity().homedir) {
  return resolve(homedir, '.local/share/deploy.local/task-workers', workerId);
}
