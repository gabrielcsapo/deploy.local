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
    let revoke: () -> Void
    @State private var copied: String?

    var body: some View {
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
                    Button { copy(command) } label: {
                        HStack(spacing: 6) {
                            Text(command).font(.system(.caption, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                            Image(systemName: copied == command ? "checkmark" : "doc.on.doc")
                        }
                    }.buttonStyle(.plain).accessibilityLabel(copied == command ? "Copied \(command)" : "Copy \(command)")
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

    private func copy(_ command: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(command, forType: .string)
        #else
        UIPasteboard.general.string = command
        #endif
        copied = command
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
