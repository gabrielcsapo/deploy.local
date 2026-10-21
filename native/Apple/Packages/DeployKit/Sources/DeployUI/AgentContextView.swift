import SwiftUI
import DeployCore

/// The exact coordinator snapshot passed to this run, kept quiet until requested.
struct AgentContextView: View {
    let run: Run
    @State private var expanded = false
    var body: some View {
        if let context = run.agentContext, !context.isEmpty {
            VStack(alignment: .leading, spacing: WorkspaceStyle.space2) {
                Button("What the agent was told") { expanded.toggle() }
                    .buttonStyle(.workspaceLink)
                    .accessibilityValue(expanded ? "Expanded" : "Collapsed")
                if let timestamp = run.agentContextAt {
                    Text(timestamp).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
                if expanded {
                    ScrollView {
                        Text(context).font(.system(.caption, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                    }.frame(maxHeight: WorkspaceStyle.contentWidth)
                }
            }
        }
    }
}
