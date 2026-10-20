import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
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

/** The owner's choice to allow input lives in this unit, so only a reinstall can change it. */
export function desktopUnit(script, { allowInput = false } = {}) {
  return `[Unit]
Description=Deploy desktop capture (${allowInput ? 'input allowed' : 'view-only'})
PartOf=graphical-session.target
After=graphical-session-pre.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 ${unitQuote(script)}${allowInput ? ' --allow-input' : ''}
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=yes

[Install]
WantedBy=graphical-session.target
`;
}

function minutes(seconds) {
  const value = Math.round(seconds / 60);
  return `${value} minute${value === 1 ? '' : 's'}`;
}

function lockLine(lock, backup) {
  if (!lock || typeof lock.locks !== 'boolean') return null;
  if (lock.locks)
    return `Screen lock: on${lock.idleSeconds ? `, after ${minutes(lock.idleSeconds)} idle` : ''}. Keep it unlocked: deploy desktop-helper screen-lock off`;
  return backup
    ? `Screen lock: off (turned off by deploy on ${backup.changedAt.slice(0, 10)}; undo: deploy desktop-helper screen-lock restore)`
    : 'Screen lock: off';
}

// The settings `screen-lock off` changes, with how to describe each value to the owner.
const gnomeLockSettings = [
  {
    schema: 'org.gnome.desktop.screensaver',
    key: 'lock-enabled',
    off: 'false',
    label: 'Lock screen when idle',
    describe: (value) => (value === 'true' ? 'on' : 'off'),
  },
  {
    schema: 'org.gnome.desktop.session',
    key: 'idle-delay',
    off: 'uint32 0',
    label: 'Blank screen after',
    describe: (value) => {
      const seconds = Number(value.split(' ').at(-1));
      return seconds ? minutes(seconds) : 'never';
    },
  },
  {
    schema: 'org.gnome.settings-daemon.plugins.power',
    key: 'idle-dim',
    off: 'false',
    label: 'Dim screen when idle',
    describe: (value) => (value === 'true' ? 'on' : 'off'),
  },
];

function readBackup(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null; // deploy has not changed the screen lock
  }
}

/** Turns the desktop's automatic lock off or back on, telling the owner exactly what changed. */
function screenLock(action, { backupPath, gsettings, desktop, name }) {
  if (!['off', 'restore'].includes(action))
    throw new Error('Usage: deploy desktop-helper screen-lock <off|restore>');
  if (desktop !== 'GNOME')
    throw new Error(
      desktop === 'KDE'
        ? 'On KDE Plasma, turn off System Settings › Screen Locking › Lock screen automatically'
        : `Screen lock settings are only managed for GNOME; this desktop is ${desktop || 'unknown'}`,
    );
  const backup = readBackup(backupPath);
  const current = Object.fromEntries(
    gnomeLockSettings.map((s) => [
      `${s.schema} ${s.key}`,
      gsettings('get', s.schema, s.key).trim(),
    ]),
  );
  const changes = [];
  for (const setting of gnomeLockSettings) {
    const id = `${setting.schema} ${setting.key}`;
    const target = action === 'off' ? setting.off : backup?.values?.[id];
    if (target === undefined || target === current[id]) continue;
    gsettings('set', setting.schema, setting.key, target);
    changes.push(
      `  ${setting.label}: ${setting.describe(current[id])} → ${setting.describe(target)}`,
    );
  }
  if (action === 'restore') {
    if (!backup) return `Nothing to restore: deploy has not changed ${name}'s screen lock.`;
    rmSync(backupPath, { force: true });
    return changes.length
      ? [`Restored ${name}'s screen lock settings:`, ...changes].join('\n')
      : `${name}'s screen lock settings already match what they were before.`;
  }
  if (!changes.length) return `Automatic screen lock is already off on ${name}.`;
  if (!backup) {
    mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      backupPath,
      JSON.stringify({ desktop, changedAt: new Date().toISOString(), values: current }, null, 2),
      { mode: 0o600 },
    );
  }
  return [
    `Turned off automatic screen lock on ${name} so desktop captures work unattended:`,
    ...changes,
    `Anyone with physical access to ${name} can now use its desktop without a password.`,
    'Undo: deploy desktop-helper screen-lock restore',
  ].join('\n');
}

export function formatDesktopStatus(status, backup = null) {
  return [
    `Desktop helper: ${status.available ? (status.inputAllowed ? 'available (input allowed)' : 'available (view-only)') : 'unavailable'}`,
    `Session: ${status.sessionType || 'unknown'} · Desktop: ${status.desktop || 'unknown'}`,
    `Portal: ${status.portalAvailable === true ? 'available' : status.sessionType === 'x11' ? 'not required (X11 direct capture)' : 'unavailable or unknown'}`,
    `Grant: ${status.grantStored === true ? 'restore token stored (portal may revoke it)' : status.grantStored === false ? 'not given yet' : 'not required or unknown'}`,
    status.available &&
      (status.inputAllowed
        ? 'Input: allowed. Approved agents can click and type on this desktop. View-only again: deploy desktop-helper install'
        : status.inputReason
          ? `Input: unavailable. ${status.inputReason}`
          : 'Input: off (view-only). Allow it: deploy desktop-helper install --allow-input'),
    lockLine(status.screenLock, backup),
    `Socket: ${status.socketPath}`,
    status.reason,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function runDesktopHelper(command, options = {}) {
  if ((options.platform || process.platform) !== 'linux')
    throw new Error('desktop-helper is for Linux; macOS workers use DEPLOY_DESKTOP_HELPER');
  if (!['install', 'status', 'uninstall', 'screen-lock'].includes(command))
    throw new Error(
      'Usage: deploy desktop-helper <install [--allow-input]|status|uninstall|screen-lock off|screen-lock restore> [--json]',
    );
  if (process.getuid?.() === 0) throw new Error('Run as the logged-in desktop user, never root');
  if (options.allowInput && command !== 'install')
    throw new Error('--allow-input only applies to deploy desktop-helper install');
  const env = options.env || process.env;
  const home = options.home || homedir();
  const config = env.XDG_CONFIG_HOME || join(home, '.config');
  const data = env.XDG_DATA_HOME || join(home, '.local/share');
  const directory = join(home, '.local/lib/deploy');
  const script = join(directory, 'desktop-helper.py');
  const unit = join(config, 'systemd/user', desktopUnitName);
  const desktop = join(data, 'applications', desktopAppId + '.desktop');
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`;
  const gsettings =
    options.gsettings ||
    ((...args) =>
      execFileSync('gsettings', args, {
        encoding: 'utf8',
        // gsettings writes through the session bus, which an SSH shell does not export.
        env: {
          ...env,
          DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtime}/bus`,
        },
      }));
  const backupPath = join(
    env.XDG_STATE_HOME || join(home, '.local/state'),
    'deploy/screen-lock-backup.json',
  );
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
    writeFileSync(unit, desktopUnit(script, { allowInput: options.allowInput === true }));
    writeFileSync(
      desktop,
      `[Desktop Entry]\nType=Application\nName=Deploy Desktop Capture\nComment=${options.allowInput === true ? 'Desktop capture and input' : 'View-only desktop capture'} for approved Deploy tasks\nExec=/usr/bin/true\nNoDisplay=true\nTerminal=false\n`,
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
  if (command === 'screen-lock')
    return screenLock(options.action, {
      backupPath,
      gsettings,
      desktop:
        status.desktop || (/gnome/i.test(env.XDG_CURRENT_DESKTOP || '') ? 'GNOME' : undefined),
      name: options.name || hostname(),
    });
  const backup = readBackup(backupPath);
  return options.json
    ? JSON.stringify(status, null, 2)
    : formatDesktopStatus(status, status.screenLock?.locks === false ? backup : null);
}
