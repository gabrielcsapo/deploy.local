import SwiftUI
import DeployCore

/// An agent asked to drive a browser or window: answer where the agent is waiting, in the
/// conversation, instead of in the Computer control panel.
struct ControlRequestCard: View {
    let request: ControlRequestSummary
    /// The task's project, when the agent may be always allowed the task browser there.
    var projectName: String? = nil
    let busy: Bool
    let respond: (_ allow: Bool, _ always: Bool) -> Void
    @Environment(\.colorScheme) private var scheme

    private var minutesLeft: Int {
        max(1, Int(((request.expiresAt / 1000) - Date().timeIntervalSince1970) / 60))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                WorkspaceGlyph(name: .computer, size: 18).foregroundStyle(WorkspaceStyle.statusAttention(scheme))
                Text("Allow agent control?").font(WorkspaceStyle.navigation.weight(.semibold))
            }
            (Text(request.targetLabel).fontWeight(.semibold) + Text(" on \(request.workerName)\(request.record == true ? ", recorded" : ""). ")
             + Text("The agent can click, type and scroll there, and its screenshots appear in this conversation. You can take control or stop at any time."))
                .font(WorkspaceStyle.body).foregroundStyle(WorkspaceStyle.text(scheme))
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 16) {
                Text("Expires in about \(minutesLeft) min").font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
                Spacer(minLength: 0)
                Button("Not now") { respond(false, false) }.buttonStyle(.workspaceLink).disabled(busy)
                Button("Allow") { respond(true, false) }.buttonStyle(.workspacePrimary).disabled(busy)
                    .accessibilityIdentifier("control-request-allow")
            }
            if let projectName, request.kind == "browser" {
                Button("Always allow the task browser in \(projectName)") { respond(true, true) }
                    .buttonStyle(.workspaceLink).disabled(busy)
                    .accessibilityIdentifier("control-request-always")
            }
        }
        .padding(14)
        .modifier(ReviewPanel(emphasized: true))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Agent control request")
    }
}
