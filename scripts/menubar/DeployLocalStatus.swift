// deploy.local menu bar status item.
//
// Subscribes to the supervisor's status socket (.deploy-data/supervisor.sock,
// NDJSON) instead of polling files — no disk involved, updates arrive the
// moment something changes, and supervisor death is detected instantly via
// socket EOF rather than a staleness heuristic.
//
// Messages:
//   {type:"status", ...} — supervisor + per-child state, pushed on connect
//                          and on every child start/exit
//   {type:"fleet", ...}  — container count + consumption, relayed from the
//                          control plane's metrics collector (30s cadence)
//
// Title shows a health dot plus the running-container count and their
// CPU/memory consumption, e.g. "● 3 · 6% · 1.1G":
//   green  — supervisor alive, edge + control both running
//   orange — a child is down/restarting, or Docker is unreachable
//   red    — supervisor not running (socket closed/refused)
//
// Build/install via `node scripts/menubar.mjs install` — compiled with swiftc,
// run as a per-user LaunchAgent. Arguments: [socketPath, logFilePath?].

import AppKit

struct ChildStatus: Decodable {
    let name: String
    let pid: Int?
    let state: String
    let startedAt: Double
    let restarts: Int
}

struct SupervisorStatus: Decodable {
    let supervisorPid: Int
    let startedAt: Double?
    let children: [ChildStatus]
}

struct ContainerStatus: Decodable {
    let name: String
    let status: String
    let cpuPercent: Double
    let memUsageBytes: Double
}

struct FleetStatus: Decodable {
    let dockerReachable: Bool
    let running: Int
    let total: Int
    /// Docker CLI convention: 100 = one core fully busy.
    let cpuPercent: Double
    let cpuCores: Int
    let memUsageBytes: Double
    let memTotalBytes: Double
    let containers: [ContainerStatus]
}

let sockPath = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : FileManager.default.currentDirectoryPath + "/.deploy-data/supervisor.sock"
let logPath: String? = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : nil

// Fleet lines arrive every 30s while the control plane is healthy; past this
// we stop showing consumption numbers (the health dot already reflects why).
let fleetStaleAfter: Double = 90

func formatUptime(_ sinceMs: Double) -> String {
    let seconds = Int(Date().timeIntervalSince1970 - sinceMs / 1000)
    if seconds < 60 { return "\(seconds)s" }
    if seconds < 3600 { return "\(seconds / 60)m" }
    if seconds < 86400 { return "\(seconds / 3600)h \((seconds % 3600) / 60)m" }
    return "\(seconds / 86400)d \((seconds % 86400) / 3600)h"
}

func formatBytes(_ bytes: Double) -> String {
    if bytes >= 1_073_741_824 { return String(format: "%.1fG", bytes / 1_073_741_824) }
    if bytes >= 1_048_576 { return String(format: "%.0fM", bytes / 1_048_576) }
    if bytes >= 1024 { return String(format: "%.0fK", bytes / 1024) }
    return "\(Int(bytes))B"
}

/// Blocking unix-socket line reader on a background thread. Reconnects every
/// 3s while the supervisor is down.
final class StatusSubscriber {
    let path: String
    let onLine: (Data) -> Void
    let onConnectionChange: (Bool) -> Void

    init(path: String, onLine: @escaping (Data) -> Void, onConnectionChange: @escaping (Bool) -> Void) {
        self.path = path
        self.onLine = onLine
        self.onConnectionChange = onConnectionChange
    }

    func start() {
        Thread.detachNewThread { [self] in
            while true {
                let fd = connectUnix(path)
                if fd >= 0 {
                    onConnectionChange(true)
                    readLines(fd)
                    close(fd)
                    onConnectionChange(false)
                }
                Thread.sleep(forTimeInterval: 3)
            }
        }
    }

    private func connectUnix(_ path: String) -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        if fd < 0 { return -1 }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let copied = withUnsafeMutableBytes(of: &addr.sun_path) { raw -> Bool in
            let bytes = Array(path.utf8)
            guard bytes.count < raw.count else { return false } // need room for NUL
            for (i, b) in bytes.enumerated() { raw[i] = b }
            raw[bytes.count] = 0
            return true
        }
        guard copied else {
            close(fd)
            return -1
        }
        let result = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        if result != 0 {
            close(fd)
            return -1
        }
        return fd
    }

    private func readLines(_ fd: Int32) {
        var buffer = [UInt8]()
        var chunk = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { return } // EOF or error — supervisor is gone
            buffer.append(contentsOf: chunk[0..<n])
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = Data(buffer[0..<nl])
                buffer.removeFirst(nl + 1)
                if !line.isEmpty { onLine(line) }
            }
            if buffer.count > 1_048_576 { return } // runaway line — resync
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    enum Health { case up, degraded, down }

    var statusItem: NSStatusItem!
    var renderTimer: Timer?
    var subscriber: StatusSubscriber?

    var connected = false
    var status: SupervisorStatus?
    var fleet: FleetStatus?
    var fleetReceivedAt: Date?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        subscriber = StatusSubscriber(
            path: sockPath,
            onLine: { [weak self] line in
                DispatchQueue.main.async { self?.handleLine(line) }
            },
            onConnectionChange: { [weak self] up in
                DispatchQueue.main.async {
                    self?.connected = up
                    if !up { self?.status = nil }
                    self?.render()
                }
            }
        )
        subscriber?.start()
        render()
        // Periodic re-render keeps uptime strings fresh between pushes.
        renderTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.render()
        }
    }

    struct TypePeek: Decodable { let type: String }

    func handleLine(_ data: Data) {
        guard let peek = try? JSONDecoder().decode(TypePeek.self, from: data) else { return }
        switch peek.type {
        case "status":
            if let s = try? JSONDecoder().decode(SupervisorStatus.self, from: data) { status = s }
        case "fleet":
            if let f = try? JSONDecoder().decode(FleetStatus.self, from: data) {
                fleet = f
                fleetReceivedAt = Date()
            }
        default:
            break
        }
        render()
    }

    func freshFleet() -> FleetStatus? {
        guard let f = fleet, let at = fleetReceivedAt,
              Date().timeIntervalSince(at) < fleetStaleAfter else { return nil }
        return f
    }

    func disabledItem(_ menu: NSMenu, _ title: String) {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        menu.addItem(item)
    }

    func render() {
        let fleet = freshFleet()
        var health: Health = .down
        var detail = "supervisor not running"

        if connected, let s = status {
            if !s.children.allSatisfy({ $0.state == "running" }) {
                health = .degraded
                let names = s.children.filter { $0.state != "running" }.map { $0.name }
                detail = "restarting: \(names.joined(separator: ", "))"
            } else if let f = fleet, !f.dockerReachable {
                health = .degraded
                detail = "docker unreachable"
            } else {
                health = .up
                detail = "all systems go"
            }
        } else if connected {
            health = .degraded
            detail = "connecting…"
        }

        let dotColor: NSColor
        switch health {
        case .up: dotColor = .systemGreen
        case .degraded: dotColor = .systemOrange
        case .down: dotColor = .systemRed
        }

        // Title: "● 3 · 6% · 1.1G" when fleet data is fresh, "● deploy" otherwise.
        var titleText = "deploy"
        if health != .down, let f = fleet, f.dockerReachable {
            let hostCpu = f.cpuCores > 0 ? f.cpuPercent / Double(f.cpuCores) : f.cpuPercent
            titleText = "\(f.running) · \(String(format: "%.0f%%", hostCpu)) · \(formatBytes(f.memUsageBytes))"
        }

        if let button = statusItem.button {
            let title = NSMutableAttributedString()
            title.append(NSAttributedString(
                string: "● ",
                attributes: [
                    .foregroundColor: dotColor,
                    .font: NSFont.systemFont(ofSize: 11),
                    .baselineOffset: 1,
                ]
            ))
            title.append(NSAttributedString(
                string: titleText,
                attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular)]
            ))
            button.attributedTitle = title
            button.toolTip = "deploy.local — \(detail)"
        }

        let menu = NSMenu()
        disabledItem(menu, "deploy.local — \(detail)")
        menu.addItem(.separator())

        if let s = status {
            for child in s.children {
                var line = child.name
                if child.state == "running", let pid = child.pid {
                    line += " — running · pid \(pid) · up \(formatUptime(child.startedAt))"
                } else {
                    line += " — \(child.state)"
                }
                if child.restarts > 0 {
                    line += " · \(child.restarts) restart\(child.restarts == 1 ? "" : "s")"
                }
                disabledItem(menu, line)
            }
            if let started = s.startedAt {
                disabledItem(menu, "supervisor — pid \(s.supervisorPid) · up \(formatUptime(started))")
            }
            menu.addItem(.separator())
        }

        if let f = fleet {
            if !f.dockerReachable {
                disabledItem(menu, "Docker — unreachable")
            } else {
                disabledItem(menu, "Containers — \(f.running) of \(f.total) running")
                if f.cpuCores > 0 {
                    let hostCpu = f.cpuPercent / Double(f.cpuCores)
                    disabledItem(menu, String(
                        format: "CPU — %.1f%% of %d core%@",
                        hostCpu, f.cpuCores, f.cpuCores == 1 ? "" : "s"
                    ))
                }
                if f.memTotalBytes > 0 {
                    let memPct = f.memUsageBytes / f.memTotalBytes * 100
                    disabledItem(menu, String(
                        format: "Memory — %@ of %@ (%.0f%%)",
                        formatBytes(f.memUsageBytes), formatBytes(f.memTotalBytes), memPct
                    ))
                }
                for c in f.containers {
                    if c.status == "running" {
                        disabledItem(menu, "  \(c.name) — \(String(format: "%.1f%%", c.cpuPercent)) · \(formatBytes(c.memUsageBytes))")
                    } else {
                        disabledItem(menu, "  \(c.name) — \(c.status)")
                    }
                }
            }
            menu.addItem(.separator())
        }

        menu.addItem(withTitle: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "d")
            .target = self
        if logPath != nil {
            menu.addItem(withTitle: "Open Server Log", action: #selector(openLog), keyEquivalent: "l")
                .target = self
        }
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        statusItem.menu = menu
    }

    @objc func openDashboard() {
        if let url = URL(string: "https://deploy.local") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc func openLog() {
        if let path = logPath {
            NSWorkspace.shared.open(URL(fileURLWithPath: path))
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
