import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { desktopRequest, desktopSocketPath } from '../server/workspace/linux-desktop.ts';

export const desktopUnitName = 'deploy-desktop-helper.service';
export const desktopAppId = 'local.deploy.DesktopHelper';

function unitQuote(value) {
  if (['\n', '\r', '\0'].some((character) => value.includes(character)))
    throw new Error('Invalid service path');
  return (
    '"' +
    value
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\\"')
      .replaceAll('%', '%%')
      .replaceAll('$', '$$') +
    '"'
  );
}

export function desktopUnit(script) {
  return `[Unit]
Description=Deploy desktop capture (view-only)
PartOf=graphical-session.target
After=graphical-session-pre.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 ${unitQuote(script)}
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=yes

[Install]
WantedBy=graphical-session.target
`;
}

export function formatDesktopStatus(status) {
  return [
    `Desktop helper: ${status.available ? 'available (view-only)' : 'unavailable'}`,
    `Session: ${status.sessionType || 'unknown'} · Desktop: ${status.desktop || 'unknown'}`,
    `Portal: ${status.portalAvailable === true ? 'available' : status.sessionType === 'x11' ? 'not required (X11 direct capture)' : 'unavailable or unknown'}`,
    `Grant: ${status.grantStored === true ? 'restore token stored (portal may revoke it)' : status.grantStored === false ? 'not given yet' : 'not required or unknown'}`,
    `Socket: ${status.socketPath}`,
    status.reason,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function runDesktopHelper(command, options = {}) {
  if ((options.platform || process.platform) !== 'linux')
    throw new Error('desktop-helper is for Linux; macOS workers use DEPLOY_DESKTOP_HELPER');
  if (!['install', 'status', 'uninstall'].includes(command))
    throw new Error('Usage: deploy desktop-helper <install|status|uninstall> [--json]');
  if (process.getuid?.() === 0) throw new Error('Run as the logged-in desktop user, never root');
  const env = options.env || process.env;
  const home = options.home || homedir();
  const config = env.XDG_CONFIG_HOME || join(home, '.config');
  const data = env.XDG_DATA_HOME || join(home, '.local/share');
  const directory = join(home, '.local/lib/deploy');
  const script = join(directory, 'desktop-helper.py');
  const unit = join(config, 'systemd/user', desktopUnitName);
  const desktop = join(data, 'applications', desktopAppId + '.desktop');
  const systemctl =
    options.systemctl ||
    ((...args) => execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8' }));
  if (command === 'install') {
    const source =
      options.source ||
      (typeof __DEPLOY_LINUX_DESKTOP_HELPER__ === 'string'
        ? __DEPLOY_LINUX_DESKTOP_HELPER__
        : readFileSync(new URL('../native/Linux/desktop-helper.py', import.meta.url), 'utf8'));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    mkdirSync(join(config, 'systemd/user'), { recursive: true });
    mkdirSync(join(data, 'applications'), { recursive: true });
    writeFileSync(script, source, { mode: 0o600 });
    writeFileSync(unit, desktopUnit(script));
    writeFileSync(
      desktop,
      `[Desktop Entry]\nType=Application\nName=Deploy Desktop Capture\nComment=View-only desktop capture for approved Deploy tasks\nExec=/usr/bin/true\nNoDisplay=true\nTerminal=false\n`,
    );
    if (env.WAYLAND_DISPLAY || env.DISPLAY) {
      const keys = [
        'WAYLAND_DISPLAY',
        'DISPLAY',
        'XAUTHORITY',
        'XDG_CURRENT_DESKTOP',
        'XDG_SESSION_TYPE',
        'DBUS_SESSION_BUS_ADDRESS',
      ].filter((key) => env[key]);
      systemctl('import-environment', ...keys);
    }
    systemctl('daemon-reload');
    systemctl('enable', desktopUnitName);
    // Never start the graphical target from an SSH or coordinator service session.
    let active = false;
    try {
      active = systemctl('is-active', 'graphical-session.target').trim() === 'active';
    } catch {
      /* starts at next graphical login */
    }
    if (active) systemctl('restart', desktopUnitName);
  } else if (command === 'uninstall') {
    systemctl('disable', '--now', desktopUnitName);
    for (const path of [unit, desktop, script]) rmSync(path, { force: true });
    systemctl('daemon-reload');
    // Remove the grant material as part of uninstall; a later install asks again.
    rmSync(join(env.XDG_STATE_HOME || join(home, '.local/state'), 'deploy/desktop-restore.json'), {
      force: true,
    });
    return 'Desktop helper uninstalled';
  }
  const socketPath = desktopSocketPath(env);
  let status;
  const attempts = command === 'install' ? 10 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      status = await (options.request || desktopRequest)('status', socketPath);
      if (typeof status.available !== 'boolean' || typeof status.reason !== 'string')
        throw new Error('Invalid desktop helper status');
      break;
    } catch (error) {
      status = {
        available: false,
        socketPath,
        reason: `Helper is not responding: ${error.message}. Check systemctl --user status ${desktopUnitName} and log in to a graphical session.`,
      };
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return options.json ? JSON.stringify(status, null, 2) : formatDesktopStatus(status);
}
