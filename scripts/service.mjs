#!/usr/bin/env node
/**
 * Install/uninstall deploy.local as a supervised system service.
 *
 *   - macOS: a launchd LaunchDaemon (/Library/LaunchDaemons/sh.deploy.server.plist)
 *   - Linux: a systemd unit (/etc/systemd/system/deploy-server.service)
 *
 * Why a system daemon (not a user agent/service): the server binds ports
 * 80/443, which requires elevated privileges, and it should run at boot
 * without a user session. The supervisor is restarted automatically if it
 * ever crashes — the containers already auto-restart via Docker, this closes
 * the gap for the proxy/control process itself.
 *
 * Usage:
 *   sudo node scripts/service.mjs install     # write unit + start at boot
 *   sudo node scripts/service.mjs restart     # restart after rebuilding
 *   sudo node scripts/service.mjs uninstall   # stop + remove unit
 *   node scripts/service.mjs status           # show service state
 *
 * The unit files are generated (not checked in) because both launchd and
 * systemd want absolute paths — node binary, working directory, and log
 * paths are resolved from the environment at install time.
 */

import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const isLinux = process.platform === 'linux';

const LABEL = 'sh.deploy.server';
const PLIST_PATH = `/Library/LaunchDaemons/${LABEL}.plist`;
const SYSTEMD_UNIT = 'deploy-server';
const UNIT_PATH = `/etc/systemd/system/${SYSTEMD_UNIT}.service`;

const repoDir = resolve(import.meta.dirname, '..');
const dataDir = process.env.DEPLOY_DATA_DIR || resolve(repoDir, '.deploy-data');
const logDir = resolve(dataDir, 'logs');
const nodeBin = process.execPath;
// The supervisor spawns the control plane (dist/server.js) and the edge
// (dist/edge.js) and restarts either on crash.
const entry = resolve(repoDir, 'dist/supervisor.js');

// Service managers start daemons with a minimal PATH; the server shells out
// to docker, tar, rsync, and openssl, so include the usual install locations.
const PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(
  ':',
);

function plistXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${entry}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${repoDir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${PATH}</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${logDir}/server.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/server.err.log</string>
</dict>
</plist>
`;
}

function systemdUnit() {
  // Run as root so the supervisor can bind 80/443 and reach the Docker socket
  // (parity with the macOS LaunchDaemon). CAP_NET_BIND_SERVICE alone would
  // cover the ports, but Docker access is simpler to guarantee as root.
  // `append:` sends stdout/stderr to the same log files the README documents;
  // journald still captures them too (view with `journalctl -u ${SYSTEMD_UNIT}`).
  return `[Unit]
Description=deploy.local server (edge + control supervisor)
Documentation=https://github.com/gabrielcsapo/deploy.local
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=${repoDir}
Environment=PATH=${PATH}
Environment=NODE_ENV=production
ExecStart=${nodeBin} ${entry}
Restart=always
RestartSec=5
StandardOutput=append:${logDir}/server.log
StandardError=append:${logDir}/server.err.log

[Install]
WantedBy=multi-user.target
`;
}

function requireRoot(action) {
  if (process.getuid?.() !== 0) {
    const target = isLinux ? UNIT_PATH : PLIST_PATH;
    console.error(`'${action}' writes ${target} — run with sudo:`);
    console.error(`  sudo node scripts/service.mjs ${action}`);
    process.exit(1);
  }
}

function launchctl(args, opts = {}) {
  return execFileSync('launchctl', args, { stdio: 'pipe', encoding: 'utf8', ...opts });
}

function systemctl(args, opts = {}) {
  return execFileSync('systemctl', args, { stdio: 'pipe', encoding: 'utf8', ...opts });
}

const command = process.argv[2];

switch (command) {
  case 'install': {
    requireRoot('install');
    if (!existsSync(entry)) {
      console.error(`Missing ${entry} — run 'pnpm build' first.`);
      process.exit(1);
    }
    mkdirSync(logDir, { recursive: true });
    if (isLinux) {
      writeFileSync(UNIT_PATH, systemdUnit());
      systemctl(['daemon-reload']);
      // enable --now: start immediately and at every boot. Re-running picks
      // up unit changes because we rewrote the file + reloaded above.
      systemctl(['enable', '--now', SYSTEMD_UNIT]);
      console.log(`Installed and started ${SYSTEMD_UNIT}`);
      console.log(`  unit: ${UNIT_PATH}`);
      console.log(`  logs: ${logDir}/server.log  (also: journalctl -u ${SYSTEMD_UNIT} -f)`);
      break;
    }
    // Bootout any previous version first so re-install picks up plist changes.
    try {
      launchctl(['bootout', `system/${LABEL}`]);
    } catch {
      // not loaded — fine
    }
    writeFileSync(PLIST_PATH, plistXml());
    launchctl(['bootstrap', 'system', PLIST_PATH]);
    console.log(`Installed and started ${LABEL}`);
    console.log(`  plist: ${PLIST_PATH}`);
    console.log(`  logs:  ${logDir}/server.log`);
    break;
  }
  case 'uninstall': {
    requireRoot('uninstall');
    if (isLinux) {
      try {
        systemctl(['disable', '--now', SYSTEMD_UNIT]);
      } catch {
        // not loaded — fine
      }
      rmSync(UNIT_PATH, { force: true });
      systemctl(['daemon-reload']);
      console.log(`Uninstalled ${SYSTEMD_UNIT}`);
      break;
    }
    try {
      launchctl(['bootout', `system/${LABEL}`]);
    } catch {
      // not loaded
    }
    rmSync(PLIST_PATH, { force: true });
    console.log(`Uninstalled ${LABEL}`);
    break;
  }
  case 'restart': {
    requireRoot('restart');
    if (!existsSync(entry)) {
      console.error(`Missing ${entry} — run 'pnpm build' first.`);
      process.exit(1);
    }
    if (isLinux) {
      if (!existsSync(UNIT_PATH)) {
        console.error(`${SYSTEMD_UNIT} is not installed — run 'sudo pnpm run service:install'.`);
        process.exit(1);
      }
      systemctl(['restart', SYSTEMD_UNIT]);
      console.log(`Restarted ${SYSTEMD_UNIT}`);
      break;
    }
    if (!existsSync(PLIST_PATH)) {
      console.error(`${LABEL} is not installed — run 'sudo pnpm run service:install'.`);
      process.exit(1);
    }
    launchctl(['kickstart', '-k', `system/${LABEL}`]);
    console.log(`Restarted ${LABEL}`);
    break;
  }
  case 'status': {
    if (isLinux) {
      try {
        const out = systemctl(['status', SYSTEMD_UNIT, '--no-pager']);
        console.log(out.trim());
      } catch (err) {
        // systemctl status exits non-zero when the unit is dead/missing, but
        // still prints useful state on stdout — surface it rather than hiding.
        const out = (err.stdout || '').toString().trim();
        console.log(out || `${SYSTEMD_UNIT} is not installed (no ${UNIT_PATH})`);
      }
      break;
    }
    try {
      const out = launchctl(['print', `system/${LABEL}`]);
      const interesting = out
        .split('\n')
        .filter((l) => /state|pid|last exit|path/.test(l))
        .join('\n');
      console.log(interesting || out);
    } catch {
      console.log(`${LABEL} is not installed (no system/${LABEL} in launchd)`);
    }
    break;
  }
  default:
    console.error('Usage: node scripts/service.mjs <install|restart|uninstall|status>');
    process.exit(1);
}
