import SwiftUI
import DeployCore

struct WorkerUpdateWarning: View {
    let update: WorkerUpdate?
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        if let update, update.needsUpdate {
            Text("Older worker: agents can't commit or deploy here")
                .font(WorkspaceStyle.metadata)
                .foregroundStyle(WorkspaceStyle.warning(colorScheme))
                .fixedSize(horizontal: false, vertical: true)
                .help(update.reason)
        }
    }
}

struct WorkerUpdateNotice: View {
    let update: WorkerUpdate?
    let platform: String
    var body: some View {
        if let update, update.needsUpdate {
            WorkspaceNotice(message: "Update available. \(update.reason) \(update.instruction(platform: platform))")
        }
    }
}
