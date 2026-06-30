#!/usr/bin/env node
/**
 * Install/uninstall deploy.local as a supervised launchd daemon (macOS).
 *
 * Why a LaunchDaemon (not a LaunchAgent): the server binds ports 80/443,
 * which requires root, and it should run at boot without a user session.
 * KeepAlive makes launchd restart the process if it ever crashes — the
 * containers already auto-restart via Docker, this closes the gap for the
 * proxy/control process itself.
 *
 * Usage:
 *   sudo node scripts/service.mjs install     # write plist + bootstrap
 *   sudo node scripts/service.mjs uninstall   # bootout + remove plist
 *   node scripts/service.mjs status           # show launchctl state
 *
 * The plist is generated (not checked in) because launchd requires absolute
 * paths — node binary, working directory, and log paths are resolved from
 * the environment at install time.
 */

import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const LABEL = 'sh.deploy.server';
const PLIST_PATH = `/Library/LaunchDaemons/${LABEL}.plist`;

const repoDir = resolve(import.meta.dirname, '..');
const dataDir = process.env.DEPLOY_DATA_DIR || resolve(repoDir, '.deploy-data');
const logDir = resolve(dataDir, 'logs');
const nodeBin = process.execPath;
// The supervisor spawns the control plane (dist/server.js) and the edge
// (dist/edge.js) and restarts either on crash.
const entry = resolve(repoDir, 'dist/supervisor.js');

// launchd starts daemons with a minimal PATH; the server shells out to
// docker, tar, rsync, and openssl, so include the usual install locations.
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

function requireRoot(action) {
  if (process.getuid?.() !== 0) {
    console.error(`'${action}' writes ${PLIST_PATH} — run with sudo:`);
    console.error(`  sudo node scripts/service.mjs ${action}`);
    process.exit(1);
  }
}

function launchctl(args, opts = {}) {
  return execFileSync('launchctl', args, { stdio: 'pipe', encoding: 'utf8', ...opts });
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
    try {
      launchctl(['bootout', `system/${LABEL}`]);
    } catch {
      // not loaded
    }
    rmSync(PLIST_PATH, { force: true });
    console.log(`Uninstalled ${LABEL}`);
    break;
  }
  case 'status': {
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
    console.error('Usage: node scripts/service.mjs <install|uninstall|status>');
    process.exit(1);
}
