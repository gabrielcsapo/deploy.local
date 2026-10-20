import SwiftUI
import DeployCore

/// An agent asked to drive a browser or window: answer where the agent is waiting, in the
/// conversation, instead of in the Computer control panel.
struct ControlRequestCard: View {
    let request: ControlRequestSummary
    let busy: Bool
    let respond: (Bool) -> Void
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
                Button("Not now") { respond(false) }.buttonStyle(.workspaceLink).disabled(busy)
                Button("Allow") { respond(true) }.buttonStyle(.workspacePrimary).disabled(busy)
                    .accessibilityIdentifier("control-request-allow")
            }
        }
        .padding(14)
        .modifier(ReviewPanel(emphasized: true))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Agent control request")
    }
}
