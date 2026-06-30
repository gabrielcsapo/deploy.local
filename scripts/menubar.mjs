#!/usr/bin/env node
/**
 * Build/install the deploy.local menu bar status item (macOS).
 *
 * A tiny AppKit app (scripts/menubar/DeployLocalStatus.swift) that subscribes
 * to the supervisor's status socket and shows a green/orange/red dot in the
 * menu bar. Unlike the server (a root LaunchDaemon, scripts/service.mjs),
 * this is a per-user LaunchAgent — it draws UI in your session and needs no
 * privileges, so no sudo.
 *
 * Usage:
 *   node scripts/menubar.mjs build       # compile with swiftc → dist/deploy-menubar
 *   node scripts/menubar.mjs install     # build + LaunchAgent + start
 *   node scripts/menubar.mjs uninstall   # stop + remove LaunchAgent
 *   node scripts/menubar.mjs status      # show launchctl state
 */

import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const LABEL = 'sh.deploy.menubar';
const PLIST_PATH = resolve(homedir(), `Library/LaunchAgents/${LABEL}.plist`);

const repoDir = resolve(import.meta.dirname, '..');
const dataDir = process.env.DEPLOY_DATA_DIR || resolve(repoDir, '.deploy-data');
const sockFile = resolve(dataDir, 'supervisor.sock');
const logFile = resolve(dataDir, 'logs/server.log');
const source = resolve(repoDir, 'scripts/menubar/DeployLocalStatus.swift');
const binary = resolve(repoDir, 'dist/deploy-menubar');

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
    build();
    break;
  case 'install': {
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
