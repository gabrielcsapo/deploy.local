import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  desktopUnit,
  desktopUnitName,
  runDesktopHelper,
  formatDesktopStatus,
} from './desktop-helper.mjs';

test('user unit is bound to the graphical session without starting a session', () => {
  const unit = desktopUnit('/home/user name/100%/desktop-helper.py');
  assert.match(unit, /PartOf=graphical-session.target/);
  assert.match(unit, /After=graphical-session-pre.target/);
  assert.doesNotMatch(unit, /After=graphical-session.target/);
  assert.match(unit, /WantedBy=graphical-session.target/);
  assert.match(unit, /UMask=0077/);
  assert.match(unit, /ExecStart=\/usr\/bin\/python3 "\/home\/user name\/100%%\/desktop-helper.py"/);
  assert.doesNotMatch(unit, /User=|sudo|Wants=|Requires=|Environment=.*DISPLAY/);
  assert.throws(() => desktopUnit('/tmp/evil\nExecStart=other'), /Invalid/);
});

test('CLI install writes the helper, identity and unit; enables only in an active session', async () => {
  const home = mkdtempSync(join(tmpdir(), 'desktop-cli-'));
  const calls = [];
  const options = {
    platform: 'linux',
    home,
    env: { XDG_RUNTIME_DIR: home },
    source: '# mocked helper',
    systemctl: (...args) => {
      calls.push(args);
      return args[0] === 'is-active' ? 'inactive' : '';
    },
    request: async () => ({
      available: true,
      sessionType: 'wayland',
      desktop: 'GNOME',
      portalAvailable: true,
      grantStored: false,
      socketPath: home + '/deploy-desktop.sock',
      reason: 'Approve on screen once',
    }),
  };
  try {
    const output = await runDesktopHelper('install', options);
    assert.match(output, /Grant: not given yet/);
    assert.match(output, /Session: wayland/);
    assert.match(output, /Portal: available/);
    assert.equal(
      readFileSync(join(home, '.local/lib/deploy/desktop-helper.py'), 'utf8'),
      '# mocked helper',
    );
    assert.match(
      readFileSync(
        join(home, '.local/share/applications/local.deploy.DesktopHelper.desktop'),
        'utf8',
      ),
      /Name=Deploy Desktop Capture/,
    );
    assert.ok(calls.some((args) => args[0] === 'enable' && args[1] === desktopUnitName));
    assert.ok(!calls.some((args) => args[0] === 'restart'));
    assert.equal(
      JSON.parse(await runDesktopHelper('status', { ...options, json: true })).desktop,
      'GNOME',
    );
    await runDesktopHelper('install', {
      ...options,
      env: { ...options.env, WAYLAND_DISPLAY: 'wayland-0' },
      systemctl: (...args) => {
        calls.push(args);
        return args[0] === 'is-active' ? 'active' : '';
      },
    });
    assert.ok(calls.some((args) => args.join(' ') === 'import-environment WAYLAND_DISPLAY'));
    assert.ok(calls.some((args) => args.join(' ') === `restart ${desktopUnitName}`));
    await runDesktopHelper('uninstall', options);
    assert.equal(existsSync(join(home, '.config/systemd/user', desktopUnitName)), false);
    assert.ok(calls.some((args) => args.join(' ') === `disable --now ${desktopUnitName}`));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('status parsing explains X11 and a missing helper, without probing a desktop', async () => {
  assert.match(
    formatDesktopStatus({ available: true, sessionType: 'x11', socketPath: '/socket' }),
    /X11 direct capture/,
  );
  const output = await runDesktopHelper('status', {
    platform: 'linux',
    request: async () => {
      throw new Error('ENOENT');
    },
  });
  assert.match(output, /unknown/);
  assert.match(output, /systemctl --user status/);
  await assert.rejects(
    runDesktopHelper('install', { platform: 'darwin' }),
    /DEPLOY_DESKTOP_HELPER/,
  );
});

test('screen-lock off says what changed, warns, keeps a backup, and restore undoes it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'desktop-lock-'));
  const values = {
    'org.gnome.desktop.screensaver lock-enabled': 'true',
    'org.gnome.desktop.session idle-delay': 'uint32 300',
    'org.gnome.settings-daemon.plugins.power idle-dim': 'true',
  };
  const status = () => ({
    available: true,
    desktop: 'GNOME',
    sessionType: 'wayland',
    socketPath: home + '/deploy-desktop.sock',
    reason: 'Desktop capture is view-only.',
    screenLock:
      values['org.gnome.desktop.screensaver lock-enabled'] === 'true'
        ? { locks: true, idleSeconds: 300 }
        : { locks: false, idleSeconds: null },
  });
  const options = {
    platform: 'linux',
    home,
    name: 'ser',
    env: { XDG_RUNTIME_DIR: home },
    request: async () => status(),
    gsettings: (verb, schema, key, value) => {
      if (verb === 'set') values[`${schema} ${key}`] = value;
      return values[`${schema} ${key}`] + '\n';
    },
  };
  try {
    assert.match(
      await runDesktopHelper('status', options),
      /Screen lock: on, after 5 minutes idle\. Keep it unlocked: deploy desktop-helper screen-lock off/,
    );
    const off = await runDesktopHelper('screen-lock', { ...options, action: 'off' });
    assert.match(off, /Turned off automatic screen lock on ser/);
    assert.match(off, /Lock screen when idle: on → off/);
    assert.match(off, /Blank screen after: 5 minutes → never/);
    assert.match(off, /Dim screen when idle: on → off/);
    assert.match(off, /physical access to ser can now use its desktop without a password/);
    assert.match(off, /Undo: deploy desktop-helper screen-lock restore/);
    assert.equal(values['org.gnome.desktop.session idle-delay'], 'uint32 0');
    assert.match(
      await runDesktopHelper('status', options),
      /Screen lock: off \(turned off by deploy on \d{4}-\d{2}-\d{2}; undo: deploy desktop-helper screen-lock restore\)/,
    );
    assert.match(
      await runDesktopHelper('screen-lock', { ...options, action: 'off' }),
      /already off on ser/,
    );
    const restored = await runDesktopHelper('screen-lock', { ...options, action: 'restore' });
    assert.match(restored, /Restored ser's screen lock settings/);
    assert.match(restored, /Blank screen after: never → 5 minutes/);
    assert.equal(values['org.gnome.desktop.screensaver lock-enabled'], 'true');
    assert.match(
      await runDesktopHelper('screen-lock', { ...options, action: 'restore' }),
      /Nothing to restore/,
    );
    await assert.rejects(
      runDesktopHelper('screen-lock', { ...options, action: 'maybe' }),
      /screen-lock <off\|restore>/,
    );
    await assert.rejects(
      runDesktopHelper('screen-lock', {
        ...options,
        action: 'off',
        request: async () => ({ ...status(), desktop: 'KDE' }),
      }),
      /Lock screen automatically/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
