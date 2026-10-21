import SwiftUI
import DeployCore

/// The exact coordinator snapshot passed to this run, kept quiet until requested.
struct AgentContextView: View {
    let run: Run
    @State private var expanded = false
    var body: some View {
        if let context = run.agentContext, !context.isEmpty {
            VStack(alignment: .leading, spacing: WorkspaceStyle.space2) {
                Button { expanded.toggle() } label: {
                    HStack(spacing: WorkspaceStyle.IconAction.gap) {
                        WorkspaceGlyph(name: expanded ? .chevronDown : .chevron, size: WorkspaceStyle.IconAction.compactGlyph)
                        Text("What the agent was told")
                    }
                }
                    .buttonStyle(.workspaceLink)
                    .accessibilityValue(expanded ? "Expanded" : "Collapsed")
                if let timestamp = TaskActivitySummary.date(run.agentContextAt) {
                    Text(timestamp, style: .relative).help(timestamp.formatted()).font(WorkspaceStyle.metadata).foregroundStyle(.secondary).textSelection(.enabled)
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
