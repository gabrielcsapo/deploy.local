import SwiftUI
import DeployCore

struct TaskRiskNotice: View {
    let risks: [TaskRisk]
    @AppStorage("workspace.riskNotice.dismissed") private var permanentlyDismissed = false
    @State private var dismissed = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.mediaConnection) private var connection
    var body: some View {
        if !risks.isEmpty && !dismissed && !permanentlyDismissed {
            VStack(alignment: .leading, spacing: WorkspaceStyle.space2) {
                HStack {
                    Text("Agent access is on").font(WorkspaceStyle.navigation.weight(.semibold))
                    Spacer()
                    WorkspaceIconButton(label: "Dismiss computer access notice", icon: .close, size: .compact) { permanentlyDismissed = true }
                }
                Text(risks.map(\.explanation).joined(separator: " ")).font(WorkspaceStyle.metadata).foregroundStyle(.secondary)
                HStack(spacing: WorkspaceStyle.space4) {
                    Button("Don't show again") { permanentlyDismissed = true }.buttonStyle(.workspaceLink)
                    if let url = URL(string: "/docs/architecture#computer-access", relativeTo: try? connection?.baseURL()) {
                        Link("Learn more", destination: url).buttonStyle(.workspaceLink)
                    }
                }
            }.padding(WorkspaceStyle.space4).background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: WorkspaceStyle.radius))
                .overlay(RoundedRectangle(cornerRadius: WorkspaceStyle.radius).strokeBorder(WorkspaceStyle.line(scheme)))
                .accessibilityIdentifier("computer-access-notice")
        }
    }
}
