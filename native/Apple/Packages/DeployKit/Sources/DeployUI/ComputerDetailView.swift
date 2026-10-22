import SwiftUI
import DeployCore

/// The same inventory and role endpoint as the web; worker-only data cannot describe deploy-only machines.
struct ComputerDetailView: View {
    let computer: Computer
    let connection: Connection
    let workers: [Worker]
    let refresh: () async -> Void
    let revoke: (Worker) -> Void
    @State private var busy = false
    @Environment(\.colorScheme) private var colorScheme
    @State private var error = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: WorkspaceStyle.space4) {
                HStack {
                    WorkspaceGlyph(name: .computer)
                    Text(computer.name).font(WorkspaceStyle.navigation)
                    if computer.roles["coordinator"] != nil { Text("Coordinator").font(WorkspaceStyle.metadata).foregroundStyle(.secondary).padding(.horizontal, WorkspaceStyle.space2).background(WorkspaceStyle.hover(colorScheme), in: Capsule()) }
                }.frame(minHeight: WorkspaceStyle.resourceRowHeight)
                Text("\(computer.platform) · \(computer.online ? "Online" : "Offline")").foregroundStyle(.secondary)
                Text(computer.roleSummary).font(WorkspaceStyle.metadata)
                if !error.isEmpty { Text(error).foregroundStyle(WorkspaceStyle.danger(colorScheme)) }
                ForEach(computerRoleOrder, id: \.self) { id in
                    if let role = computer.roles[id] {
                        VStack(alignment: .leading, spacing: WorkspaceStyle.space2) {
                            HStack {
                                Toggle(computerRoleLabels[id] ?? id, isOn: Binding(get: { role.state != "off" }, set: { enabled in
                                    Task { await toggle(id, enabled: enabled) }
                                })).disabled(busy)
                                StatusBadge(status: role.state == "ready" ? "done" : role.state == "off" ? "off" : "review", label: role.badge)
                            }
                            if role.state != "off" {
                                Text(role.reason).font(WorkspaceStyle.metadata).foregroundStyle(.secondary)
                                if let fix = role.fix { HStack { Text(fix).textSelection(.enabled); WorkspaceCopyButton(label: "Copy setup command", text: fix) } }
                            }
                        }.frame(minHeight: WorkspaceStyle.resourceRowHeight)
                        Divider()
                    }
                }
                ForEach(workers.filter { computer.workerIds.contains($0.id) }) { worker in
                    if let permissions = worker.permissions {
                        NodePermissionsList(worker: worker, permissions: permissions, showRoles: false) { revoke(worker) }
                    } else if let capture = worker.desktopCapture {
                        Text(capture.reason).font(WorkspaceStyle.metadata).foregroundStyle(.secondary)
                    }
                }
            }.padding(WorkspaceStyle.space4)
        }
    }

    private func toggle(_ id: String, enabled: Bool) async {
        busy = true; error = ""
        defer { busy = false }
        do {
            let path = computer.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#%"))) ?? computer.id
            let _: JSONValue = try await WorkspaceClient(connection: connection).request("/api/computers/\(path)/roles", method: "PATCH", body: JSONEncoder().encode([id: enabled]))
            await refresh()
        } catch { self.error = coordinatorErrorDescription(error) }
    }
}

struct ComputerEnrollmentSheet: View {
    let connection: Connection
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var platform = "darwin"
    @State private var roles = ["deploy": false, "tasks": true, "computer": true, "browser": true]
    @State private var result: Enrollment?
    @State private var busy = false
    @Environment(\.colorScheme) private var colorScheme
    @State private var error = ""
    private struct Enrollment: Decodable, Sendable { let name: String; let code: String; let expiresAt: Double }
    private struct Request: Encodable { let name: String; let roles: [String: Bool] }
    var body: some View {
        VStack(alignment: .leading, spacing: WorkspaceStyle.space4) {
            Text("Connect a computer").font(.headline)
            if !error.isEmpty { Text(error).foregroundStyle(WorkspaceStyle.danger(colorScheme)) }
            if let result {
                Text("Enrollment for \(result.name)")
                Text("Expires \(Date(timeIntervalSince1970: result.expiresAt / 1000).formatted())").font(WorkspaceStyle.metadata)
                Text("Run on that computer, then enter the enrollment code when prompted.")
                let command = "\(platform == "linux" && roles["deploy"] == true ? "sudo " : "")deploy agent join \(connection.origin)"
                HStack { Text(command).textSelection(.enabled); WorkspaceCopyButton(label: "Copy enrollment command", text: command) }
                HStack { Text(result.code).textSelection(.enabled); WorkspaceCopyButton(label: "Copy enrollment code", text: result.code) }
                Text("Provider sign-in, Chromium, and screen permissions are set up locally on that computer.").font(WorkspaceStyle.metadata).foregroundStyle(.secondary)
            } else {
                TextField("Computer name", text: $name)
                Picker("Platform", selection: $platform) { Text("macOS").tag("darwin"); Text("Linux").tag("linux") }
                ForEach(computerRoleOrder, id: \.self) { id in
                    Toggle(computerRoleLabels[id] ?? id, isOn: Binding(get: { roles[id] == true }, set: { roles[id] = $0 }))
                }
                Button("Create enrollment") { Task { await create() } }.buttonStyle(.workspacePrimary).disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            Button(result == nil ? "Cancel" : "Done") { dismiss() }.buttonStyle(.workspaceLink)
        }.padding(WorkspaceStyle.space4).frame(idealWidth: 480).disabled(busy)
    }
    private func create() async {
        busy = true; error = ""; defer { busy = false }
        do {
            result = try await WorkspaceClient(connection: connection).request("/api/nodes/enrollment", method: "POST", body: JSONEncoder().encode(Request(name: name.trimmingCharacters(in: .whitespaces), roles: roles)))
        } catch { self.error = coordinatorErrorDescription(error) }
    }
}
