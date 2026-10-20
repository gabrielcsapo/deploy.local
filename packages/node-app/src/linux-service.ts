import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
const exec = promisify(execFile);
const configHome = () => process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
export const autostartPath = () => join(configHome(), 'autostart/deploy-node.desktop');
export function autostartEnabled() {
  return existsSync(autostartPath());
}
/** Desktop Entry quoting, not shell quoting. Reject newlines; escape field codes too. */
export function desktopExec(args: string[]) {
  return args
    .map((arg) => {
      if (['\n', '\r', '\0'].some((character) => arg.includes(character)))
        throw new Error('Invalid launcher path');
      return '"' + arg.replace(/[\\"`$]/g, '\\$&').replaceAll('%', '%%') + '"';
    })
    .join(' ');
}
export function setAutostart(enabled: boolean, args: string[]) {
  const path = autostartPath();
  if (!enabled) return rmSync(path, { force: true });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `[Desktop Entry]\nType=Application\nName=deploy.local Node\nComment=Background task worker and desktop permissions\nExec=${desktopExec(args)}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`,
  );
}
export async function removeLegacyTray() {
  const paths = [
    ...new Set([
      join(configHome(), 'systemd/user/deploy-menubar.service'),
      join(homedir(), '.config/systemd/user/deploy-menubar.service'),
    ]),
  ];
  if (!paths.some(existsSync)) return false;
  // Do not remove the unit until systemd confirms it is disabled and stopped.
  await exec('systemctl', ['--user', 'disable', '--now', 'deploy-menubar.service']);
  for (const path of paths) rmSync(path, { force: true });
  await exec('systemctl', ['--user', 'daemon-reload']);
  console.log('Replaced deploy-menubar.service with deploy.local Node.');
  return true;
}
export async function controlServer(action: 'start' | 'stop' | 'restart') {
  const args = [action, 'deploy-server.service'];
  try {
    await exec('systemctl', ['--no-ask-password', ...args]);
    return;
  } catch (failure) {
    // pkexec is only appropriate for a known system unit and an authorization failure.
    const detail = String((failure as { stderr?: string }).stderr || '');
    const { stdout: fragment } = await exec('systemctl', [
      'show',
      '-p',
      'FragmentPath',
      '--value',
      'deploy-server.service',
    ]).catch(() => ({ stdout: '' }));
    if (
      !/^\/(etc|usr\/lib|lib)\/systemd\/system\//.test(fragment.trim()) ||
      !/access denied|authentication|permission|not authorized/i.test(detail)
    )
      throw new Error(`Run: systemctl ${args.join(' ')}`);
    try {
      await exec('pkexec', ['systemctl', ...args]);
    } catch {
      throw new Error(`Run: pkexec systemctl ${args.join(' ')}`);
    }
  }
}
export function readJournal() {
  return exec(
    'journalctl',
    ['-u', 'deploy-server.service', '-n', '300', '--no-pager', '--output=short-iso'],
    { maxBuffer: 1024 * 1024 },
  ).then(({ stdout }) => stdout);
}
export function readBundledHelper(path: string) {
  return readFileSync(path, 'utf8');
}
