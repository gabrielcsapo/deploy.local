#!/usr/bin/env node
/**
 * Build/install the deploy.local tray status indicator.
 *
 *   - macOS: a tiny AppKit app (scripts/menubar/DeployLocalStatus.swift),
 *     compiled with swiftc, run as a per-user LaunchAgent.
 *   - Linux: a gjs app (scripts/menubar/DeployLocalStatus.js) shown via
 *     AppIndicator/StatusNotifierItem, run as a per-user systemd service.
 *
 * Both subscribe to the supervisor's status socket and show a green/orange/red
 * health indicator. Unlike the server (a root system daemon, see
 * scripts/service.mjs), this draws UI in your session and needs no privileges,
 * so no sudo.
 *
 * Usage:
 *   node scripts/menubar.mjs build       # macOS: swiftc → dist/deploy-menubar
 *                                         # Linux: verify gjs + AppIndicator typelib
 *   node scripts/menubar.mjs install     # build + register service + start
 *   node scripts/menubar.mjs uninstall   # stop + remove service
 *   node scripts/menubar.mjs status      # show service state
 */

import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const isLinux = process.platform === 'linux';

const LABEL = 'sh.deploy.menubar';
const PLIST_PATH = resolve(homedir(), `Library/LaunchAgents/${LABEL}.plist`);
const SYSTEMD_UNIT = 'deploy-menubar';
const UNIT_PATH = resolve(homedir(), `.config/systemd/user/${SYSTEMD_UNIT}.service`);

const repoDir = resolve(import.meta.dirname, '..');
const dataDir = process.env.DEPLOY_DATA_DIR || resolve(repoDir, '.deploy-data');
const sockFile = resolve(dataDir, 'supervisor.sock');
const logFile = resolve(dataDir, 'logs/server.log');
const source = resolve(repoDir, 'scripts/menubar/DeployLocalStatus.swift');
const binary = resolve(repoDir, 'dist/deploy-menubar');
const gjsScript = resolve(repoDir, 'scripts/menubar/DeployLocalStatus.js');

function build() {
  mkdirSync(resolve(repoDir, 'dist'), { recursive: true });
  try {
    execFileSync('swiftc', ['-O', source, '-o', binary], { stdio: 'inherit' });
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(
        'swiftc not found — install the Xcode Command Line Tools (xcode-select --install)',
      );
      process.exit(1);
    }
    throw err;
  }
  console.log(`Built ${binary}`);
}

// Linux has nothing to compile (gjs is interpreted); "build" just verifies the
// runtime and the AppIndicator GObject-introspection typelib are present, since
// a missing typelib fails at import time with an opaque error otherwise.
function buildLinux() {
  try {
    execFileSync('gjs', ['--version'], { stdio: 'pipe' });
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error('gjs not found — install it:\n  sudo apt install gjs');
      process.exit(1);
    }
    throw err;
  }
  const probe =
    "imports.gi.versions.AyatanaAppIndicator3='0.1';" +
    'try{imports.gi.AyatanaAppIndicator3;}catch(e){' +
    "imports.gi.versions.AppIndicator3='0.1';imports.gi.AppIndicator3;}";
  try {
    execFileSync('gjs', ['-c', probe], { stdio: 'pipe' });
  } catch {
    console.error(
      'AppIndicator typelib not found — install it:\n' +
        '  sudo apt install gir1.2-ayatanaappindicator3-0.1',
    );
    process.exit(1);
  }
  console.log(`Tray script ready: ${gjsScript}`);
}

function gjsPath() {
  // Resolve gjs to an absolute path so the systemd unit doesn't depend on the
  // user-manager PATH.
  return execFileSync('sh', ['-c', 'command -v gjs'], { encoding: 'utf8' }).trim();
}

function systemdUserUnit() {
  return `[Unit]
Description=deploy.local tray status indicator
Documentation=https://github.com/gabrielcsapo/deploy.local
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart=${gjsPath()} ${gjsScript} ${sockFile} ${logFile}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=graphical-session.target
`;
}

function systemctlUser(args, opts = {}) {
  return execFileSync('systemctl', ['--user', ...args], {
    stdio: 'pipe',
    encoding: 'utf8',
    ...opts,
  });
}

function plistXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binary}</string>
    <string>${sockFile}</string>
    <string>${logFile}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
</dict>
</plist>
`;
}

function launchctl(args, opts = {}) {
  return execFileSync('launchctl', args, { stdio: 'pipe', encoding: 'utf8', ...opts });
}

const uid = process.getuid();
const command = process.argv[2];

switch (command) {
  case 'build':
    if (isLinux) buildLinux();
    else build();
    break;
  case 'install': {
    if (isLinux) {
      buildLinux();
      mkdirSync(resolve(homedir(), '.config/systemd/user'), { recursive: true });
      writeFileSync(UNIT_PATH, systemdUserUnit());
      systemctlUser(['daemon-reload']);
      // enable --now: start in this session and at every login. Re-running
      // picks up unit changes because we rewrote the file + reloaded above.
      systemctlUser(['enable', '--now', SYSTEMD_UNIT]);
      console.log(
        `Installed and started ${SYSTEMD_UNIT} — look for the deploy.local item in your top bar`,
      );
      console.log(`  unit:   ${UNIT_PATH}`);
      console.log(`  socket: ${sockFile}`);
      console.log(`  logs:   journalctl --user -u ${SYSTEMD_UNIT} -f`);
      break;
    }
    build();
    mkdirSync(resolve(homedir(), 'Library/LaunchAgents'), { recursive: true });
    // Bootout any previous version so re-install picks up binary/plist changes.
    try {
      launchctl(['bootout', `gui/${uid}/${LABEL}`]);
    } catch {
      // not loaded — fine
    }
    writeFileSync(PLIST_PATH, plistXml());
    launchctl(['bootstrap', `gui/${uid}`, PLIST_PATH]);
    console.log(`Installed and started ${LABEL} — look for the ● deploy item in your menu bar`);
    console.log(`  plist:  ${PLIST_PATH}`);
    console.log(`  socket: ${sockFile}`);
    break;
  }
  case 'uninstall': {
    if (isLinux) {
      try {
        systemctlUser(['disable', '--now', SYSTEMD_UNIT]);
      } catch {
        // not loaded — fine
      }
      rmSync(UNIT_PATH, { force: true });
      systemctlUser(['daemon-reload']);
      console.log(`Uninstalled ${SYSTEMD_UNIT}`);
      break;
    }
    try {
      launchctl(['bootout', `gui/${uid}/${LABEL}`]);
    } catch {
      // not loaded
    }
    rmSync(PLIST_PATH, { force: true });
    console.log(`Uninstalled ${LABEL}`);
    break;
  }
  case 'status': {
    if (isLinux) {
      try {
        const out = systemctlUser(['status', SYSTEMD_UNIT, '--no-pager']);
        console.log(out.trim());
      } catch (err) {
        const out = (err.stdout || '').toString().trim();
        console.log(out || `${SYSTEMD_UNIT} is not installed (no ${UNIT_PATH})`);
      }
      break;
    }
    try {
      const out = launchctl(['print', `gui/${uid}/${LABEL}`]);
      const interesting = out
        .split('\n')
        .filter((l) => /state|pid|last exit|path/.test(l))
        .join('\n');
      console.log(interesting || out);
    } catch {
      console.log(`${LABEL} is not installed (no gui/${uid}/${LABEL} in launchd)`);
    }
    if (!existsSync(binary)) {
      console.log(`note: ${binary} not built — run 'node scripts/menubar.mjs build'`);
    }
    break;
  }
  default:
    console.error('Usage: node scripts/menubar.mjs <build|install|uninstall|status>');
    process.exit(1);
}
