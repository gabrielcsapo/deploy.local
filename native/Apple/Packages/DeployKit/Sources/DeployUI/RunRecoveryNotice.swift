import SwiftUI
import DeployCore

/// Above the composer for a run a computer restart interrupted: never shown as working.
struct RunRecoveryNotice: View {
    let recovery: RunRecovery
    var busy = false
    let markStopped: () -> Void
    @State private var confirming = false
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: recovery.isResolved ? "stop.circle" : "exclamationmark.circle")
                .foregroundStyle(recovery.isResolved ? WorkspaceStyle.secondaryText(colorScheme) : WorkspaceStyle.statusAttention(colorScheme))
            VStack(alignment: .leading, spacing: 2) {
                Text(recovery.title).font(.caption.weight(.semibold))
                Text(recovery.detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }.frame(maxWidth: .infinity, alignment: .leading)
            if recovery.canMarkStopped {
                Button("Mark as stopped…") { confirming = true }
                    .buttonStyle(.bordered).controlSize(.small).disabled(busy)
                    .accessibilityIdentifier("run-recovery-mark-stopped")
            }
        }.padding(.horizontal, 12).padding(.vertical, 10)
            .background(WorkspaceStyle.surface(colorScheme).opacity(0.7), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(WorkspaceStyle.line(colorScheme).opacity(0.7), lineWidth: 1))
            .accessibilityElement(children: .contain).accessibilityIdentifier("run-recovery")
            .confirmationDialog("Mark this run as stopped?", isPresented: $confirming, titleVisibility: .visible) {
                Button("I’ve checked — mark stopped", role: .destructive, action: markStopped)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Only do this after checking that nothing from this run is still running on that computer. Its last changes stay in the task workspace, and your next message continues the conversation.")
            }
    }
}
