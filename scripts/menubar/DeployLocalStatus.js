// deploy.local tray status indicator (Linux / GNOME).
//
// The gjs counterpart to scripts/menubar/DeployLocalStatus.swift. Same data
// source, same UI semantics — it subscribes to the supervisor's status socket
// (.deploy-data/supervisor.sock, NDJSON) and shows a green/orange/red health
// indicator in the top bar via AppIndicator (StatusNotifierItem), rendered by
// the ubuntu-appindicators GNOME extension.
//
// Messages:
//   {type:"status", ...} — supervisor + per-child state, pushed on connect
//                          and on every child start/exit
//   {type:"fleet", ...}  — container count + consumption, relayed from the
//                          control plane's metrics collector (~30s cadence)
//
// Label shows the running-container count and their CPU/memory, e.g.
// "3 · 6% · 1.1G"; the icon color carries health:
//   green  — supervisor alive, edge + control both running
//   orange — a child is down/restarting, or Docker is unreachable
//   red    — supervisor not running (socket closed/refused)
//
// When our custom colored-dot icons can't be resolved by the icon theme we
// fall back to a stock icon plus a colored emoji in the label, so health is
// always visible regardless of theme quirks.
//
// Run via `node scripts/menubar.mjs install` (a per-user systemd service).
// Arguments: [socketPath, logFilePath?].

imports.gi.versions.Gtk = '3.0';
imports.gi.versions.AyatanaAppIndicator3 = '0.1';

const { GLib, Gio, Gtk } = imports.gi;

// Prefer the maintained Ayatana fork; fall back to the legacy AppIndicator3.
let AppIndicator;
try {
  AppIndicator = imports.gi.AyatanaAppIndicator3;
} catch {
  imports.gi.versions.AppIndicator3 = '0.1';
  AppIndicator = imports.gi.AppIndicator3;
}

const sockPath = ARGV[0] || GLib.get_current_dir() + '/.deploy-data/supervisor.sock';
const logPath = ARGV[1] || null;

// Fleet lines arrive every ~30s while the control plane is healthy; past this
// we stop showing consumption numbers (the health color already reflects why).
const FLEET_STALE_AFTER_MS = 90 * 1000;

// ── Formatting (mirrors the Swift app) ──────────────────────────────────────

function formatUptime(sinceMs) {
  const seconds = Math.floor(Date.now() / 1000 - sinceMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400)
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

function formatBytes(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)}G`;
  if (bytes >= 1048576) return `${Math.round(bytes / 1048576)}M`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}K`;
  return `${Math.round(bytes)}B`;
}

// ── Custom colored-dot icons ────────────────────────────────────────────────
// Write a tiny SVG theme so the indicator can show an Apple-style colored dot.
// If anything here fails, useCustomIcons stays false and we use emoji instead.

const ICON_COLORS = { green: '#34c759', orange: '#ff9f0a', red: '#ff453a' };

function ensureIcons() {
  const base = GLib.build_filenamev([GLib.get_user_cache_dir(), 'deploy-local-tray', 'icons']);
  const statusDir = GLib.build_filenamev([base, 'hicolor', 'scalable', 'status']);
  try {
    Gio.File.new_for_path(statusDir).make_directory_with_parents(null);
  } catch {
    // already exists — fine
  }
  for (const [name, color] of Object.entries(ICON_COLORS)) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">` +
      `<circle cx="11" cy="11" r="7" fill="${color}"/></svg>\n`;
    const file = GLib.build_filenamev([statusDir, `deploy-status-${name}.svg`]);
    try {
      GLib.file_set_contents(file, svg);
    } catch {
      return null;
    }
  }
  return base;
}

// GTK must be initialized before any icon-theme access — get_default() needs
// an open display/screen, otherwise it returns null.
Gtk.init(null);

const iconBase = ensureIcons();
const iconTheme = Gtk.IconTheme.get_default();
if (iconBase) iconTheme.append_search_path(iconBase);
const useCustomIcons = iconBase != null && iconTheme.has_icon('deploy-status-green');

const ICON_NAME = {
  up: useCustomIcons ? 'deploy-status-green' : 'utilities-system-monitor',
  degraded: useCustomIcons ? 'deploy-status-orange' : 'utilities-system-monitor',
  down: useCustomIcons ? 'deploy-status-red' : 'utilities-system-monitor',
};
const EMOJI = { up: '🟢', degraded: '🟠', down: '🔴' };

// ── State ───────────────────────────────────────────────────────────────────

let connected = false;
let status = null; // last {type:'status'} payload
let fleet = null; // last {type:'fleet'} payload
let fleetReceivedAt = 0;

function freshFleet() {
  if (fleet && Date.now() - fleetReceivedAt < FLEET_STALE_AFTER_MS) return fleet;
  return null;
}

// ── Indicator ───────────────────────────────────────────────────────────────

const indicator = AppIndicator.Indicator.new(
  'deploy-local',
  ICON_NAME.down,
  AppIndicator.IndicatorCategory.APPLICATION_STATUS,
);
if (iconBase) indicator.set_icon_theme_path(iconBase);
indicator.set_status(AppIndicator.IndicatorStatus.ACTIVE);

function disabledItem(menu, label) {
  const item = new Gtk.MenuItem({ label });
  item.set_sensitive(false);
  menu.append(item);
}

function actionItem(menu, label, onActivate) {
  const item = new Gtk.MenuItem({ label });
  item.connect('activate', onActivate);
  menu.append(item);
}

function render() {
  const f = freshFleet();
  let health = 'down';
  let detail = 'supervisor not running';

  if (connected && status) {
    const down = status.children.filter((c) => c.state !== 'running');
    if (down.length > 0) {
      health = 'degraded';
      detail = `restarting: ${down.map((c) => c.name).join(', ')}`;
    } else if (f && !f.dockerReachable) {
      health = 'degraded';
      detail = 'docker unreachable';
    } else {
      health = 'up';
      detail = 'all systems go';
    }
  } else if (connected) {
    health = 'degraded';
    detail = 'connecting…';
  }

  // Label: "3 · 6% · 1.1G" when fleet data is fresh, else "deploy".
  let labelText = 'deploy';
  if (health !== 'down' && f && f.dockerReachable) {
    const hostCpu = f.cpuCores > 0 ? f.cpuPercent / f.cpuCores : f.cpuPercent;
    labelText = `${f.running} · ${Math.round(hostCpu)}% · ${formatBytes(f.memUsageBytes)}`;
  }
  const label = useCustomIcons ? labelText : `${EMOJI[health]} ${labelText}`;

  indicator.set_icon_full(ICON_NAME[health], `deploy.local — ${detail}`);
  indicator.set_label(label, '3 · 00% · 0.0G');
  indicator.set_title(`deploy.local — ${detail}`);

  // Rebuild the menu each render (matches the Swift app).
  const menu = new Gtk.Menu();
  disabledItem(menu, `deploy.local — ${detail}`);
  menu.append(new Gtk.SeparatorMenuItem());

  if (status) {
    for (const child of status.children) {
      let line = child.name;
      if (child.state === 'running' && child.pid) {
        line += ` — running · pid ${child.pid} · up ${formatUptime(child.startedAt)}`;
      } else {
        line += ` — ${child.state}`;
      }
      if (child.restarts > 0) {
        line += ` · ${child.restarts} restart${child.restarts === 1 ? '' : 's'}`;
      }
      disabledItem(menu, line);
    }
    if (status.startedAt) {
      disabledItem(
        menu,
        `supervisor — pid ${status.supervisorPid} · up ${formatUptime(status.startedAt)}`,
      );
    }
    menu.append(new Gtk.SeparatorMenuItem());
  }

  if (f) {
    if (!f.dockerReachable) {
      disabledItem(menu, 'Docker — unreachable');
    } else {
      disabledItem(menu, `Containers — ${f.running} of ${f.total} running`);
      if (f.cpuCores > 0) {
        const hostCpu = f.cpuPercent / f.cpuCores;
        disabledItem(
          menu,
          `CPU — ${hostCpu.toFixed(1)}% of ${f.cpuCores} core${f.cpuCores === 1 ? '' : 's'}`,
        );
      }
      if (f.memTotalBytes > 0) {
        const memPct = (f.memUsageBytes / f.memTotalBytes) * 100;
        disabledItem(
          menu,
          `Memory — ${formatBytes(f.memUsageBytes)} of ${formatBytes(f.memTotalBytes)} (${Math.round(memPct)}%)`,
        );
      }
      for (const c of f.containers) {
        if (c.status === 'running') {
          disabledItem(
            menu,
            `  ${c.name} — ${c.cpuPercent.toFixed(1)}% · ${formatBytes(c.memUsageBytes)}`,
          );
        } else {
          disabledItem(menu, `  ${c.name} — ${c.status}`);
        }
      }
    }
    menu.append(new Gtk.SeparatorMenuItem());
  }

  actionItem(menu, 'Open Dashboard', () => {
    try {
      Gio.AppInfo.launch_default_for_uri('https://deploy.local', null);
    } catch {
      // no default browser configured — ignore
    }
  });
  if (logPath) {
    actionItem(menu, 'Open Server Log', () => {
      try {
        Gio.AppInfo.launch_default_for_uri('file://' + logPath, null);
      } catch {
        // ignore
      }
    });
  }
  menu.append(new Gtk.SeparatorMenuItem());
  actionItem(menu, 'Quit', () => Gtk.main_quit());

  menu.show_all();
  indicator.set_menu(menu);
}

// ── Status socket subscriber ────────────────────────────────────────────────
// Blocking-free async line reader. Reconnects every 3s while the supervisor is
// down; EOF on the socket means the supervisor is gone (health → red).

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // malformed line — ignore
  }
  if (msg.type === 'status') {
    status = msg;
  } else if (msg.type === 'fleet') {
    fleet = msg;
    fleetReceivedAt = Date.now();
  } else {
    return;
  }
  render();
}

function scheduleReconnect() {
  GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
    connectSocket();
    return GLib.SOURCE_REMOVE;
  });
}

function onDisconnect(conn) {
  if (conn) {
    try {
      conn.close(null);
    } catch {
      // already closed
    }
  }
  if (connected || status) {
    connected = false;
    status = null;
    render();
  }
  scheduleReconnect();
}

function readNext(dis, conn) {
  dis.read_line_async(GLib.PRIORITY_DEFAULT, null, (obj, res) => {
    let line;
    try {
      [line] = dis.read_line_finish_utf8(res);
    } catch {
      onDisconnect(conn);
      return;
    }
    if (line === null) {
      onDisconnect(conn); // EOF
      return;
    }
    if (line.length > 0) handleLine(line);
    readNext(dis, conn);
  });
}

function connectSocket() {
  const client = new Gio.SocketClient();
  const addr = new Gio.UnixSocketAddress({ path: sockPath });
  client.connect_async(addr, null, (obj, res) => {
    let conn;
    try {
      conn = client.connect_finish(res);
    } catch {
      onDisconnect(null); // supervisor not up yet — retry
      return;
    }
    connected = true;
    render();
    const dis = new Gio.DataInputStream({ base_stream: conn.get_input_stream() });
    readNext(dis, conn);
  });
}

// Periodic re-render keeps uptime strings fresh between pushes.
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
  render();
  return GLib.SOURCE_CONTINUE;
});

render();
connectSocket();
Gtk.main();
