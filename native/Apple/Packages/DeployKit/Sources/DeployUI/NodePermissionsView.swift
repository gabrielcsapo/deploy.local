import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif
import DeployCore

/// A computer's permissions, each with its one next step. Steps on the computer are commands or
/// settings to change there; this view never grants desktop access remotely.
struct NodePermissionsList: View {
    let worker: Worker
    let permissions: [NodePermission]
    var showRoles = true
    let revoke: () -> Void

    var body: some View {
        if showRoles { ComputerRoleChips(roles: worker.roles) }
        ForEach(permissions) { permission in
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(permission.label).font(WorkspaceStyle.navigation)
                    Spacer()
                    StatusBadge(status: Self.tone(permission.state), label: permission.badge)
                }
                Text(permission.summary).font(WorkspaceStyle.metadata).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let step = permission.step { stepView(step) }
            }.padding(.vertical, 2)
        }
    }

    @ViewBuilder private func stepView(_ step: NodePermission.Step) -> some View {
        if step.onComputer {
            VStack(alignment: .leading, spacing: 4) {
                Text("\(step.label) · on \(worker.name)").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                if let command = step.command {
                    HStack(spacing: WorkspaceStyle.IconAction.gap) {
                        Text(command).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        WorkspaceCopyButton(label: "Copy setup command", text: command)
                    }
                }
                if let instruction = step.instruction {
                    Text(instruction).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
        } else if step.action == "revoke-worker" {
            Button(step.label, role: .destructive, action: revoke)
        } else {
            Text("Change it in each repository’s settings.").font(.caption).foregroundStyle(.secondary)
        }
    }

    /// StatusBadge colors by task status; borrow the matching tone.
    static func tone(_ state: String) -> String {
        switch state {
        case "on": "done"
        case "needs-approval": "review"
        case "unavailable": "failed"
        default: "off"
        }
    }
}

struct ComputerRoleChips: View {
    let roles: [String: ComputerRole]?
    private let order = ["coordinator", "deploy", "tasks", "computer", "browser"]
    private let labels = ["coordinator": "Coordinator", "deploy": "Deploy apps", "tasks": "Coding tasks", "computer": "Screen access", "browser": "Task browser"]
    var body: some View {
        if let roles {
            ViewThatFits(in: .horizontal) {
                HStack { chips(roles) }
                VStack(alignment: .leading) { chips(roles) }
            }
        }
    }
    @ViewBuilder private func chips(_ roles: [String: ComputerRole]) -> some View {
        ForEach(order, id: \.self) { id in
            if let role = roles[id] {
                StatusBadge(status: role.state == "ready" ? "done" : role.state == "needs-setup" ? "review" : "off", label: "\(labels[id] ?? id) · \(role.badge)")
                    .help(role.reason)
            }
        }
    }
}
