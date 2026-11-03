#if os(iOS)
import SwiftUI
import DeployCore

struct V2SettingsApprovals: View {
    @Bindable var store: V2Store
    @State private var approvals: V2Approvals?
    @State private var selected: V2Agent?
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        NavigationStack {
            ScrollView {
                V2SettingsGroup(list: true, title: "Agents", note: "Action rules are read-only here; change them on a computer.") {
                    ForEach(store.snapshot.agents) { agent in
                        Button { selected = agent } label: { V2SettingsRow(list: true, title: agent.name, subtitle: summary(agent), identity: agent.identity) { V2SettingsChevron() } }
                    }
                    if store.snapshot.agents.isEmpty { V2SettingsRow(list: true, title: "No agents", icon: "person") { EmptyView() } }
                    if let error { Text(error).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.danger(scheme)) }
                }.padding(16)
            }.background(WorkspaceStyle.canvas(scheme)).navigationTitle("What agents may do").navigationBarTitleDisplayMode(.inline).toolbar { Button("Done") { dismiss() } }
                .sheet(item: $selected, onDismiss: { Task { await load() } }) { V2AgentRules(store: store, agent: $0) }
                .task {
                    await load()
                    if V2Evidence.agentsBoard == .rules { selected = store.snapshot.agents.first { $0.id == "release-notes-writer" } }
                }
        }
    }
    private func summary(_ agent: V2Agent) -> String {
        guard let approvals else { return "Unavailable" }
        return approvals.summary(agent: agent.id)
    }
    private func load() async { do { approvals = try await store.client.approvals(); error = nil } catch { self.error = coordinatorErrorDescription(error) } }
}
struct V2AgentRules: View {
    @Bindable var store: V2Store
    let agent: V2Agent
    @State private var approvals: V2Approvals?
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        NavigationStack {
            ScrollView {
                V2SettingsGroup(list: true, title: "What it may do", note: "Merging and rolling back always show you what changes first.\n\nRules are edited on a computer.") {
                    ForEach(V2ApprovalAction.allCases, id: \.self) { action in
                        V2SettingsRow(list: true, title: action.label, subtitle: explanation(action), icon: icon(action), glyph: action == .openPullRequest ? .pullRequest : nil) {
                            Text(approvals?.mode(agent: agent.id, action: action).label ?? "Unavailable").font(.system(size: 15)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
                        }
                    }
                    if let error { Text(error).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.danger(scheme)) }
                }.padding(16)
            }.background(WorkspaceStyle.canvas(scheme)).navigationTitle(agent.name).navigationBarTitleDisplayMode(.inline).toolbar { Button("Done") { dismiss() } }
                .task { do { approvals = try await store.client.approvals() } catch { self.error = coordinatorErrorDescription(error) } }
        }
    }
    private func explanation(_ action: V2ApprovalAction) -> String {
        switch action { case .startTask: "Work on a branch inside its limits"; case .openPullRequest: "Bring a branch for review"; case .merge: "Apply a reviewed change"; case .restart: "Stop and start the running app"; case .rollback: "Restore the previous release" }
    }
    private func icon(_ action: V2ApprovalAction) -> String {
        switch action { case .startTask: "list.clipboard"; case .openPullRequest: "arrow.triangle.branch"; case .merge: "arrow.triangle.merge"; case .restart: "arrow.clockwise"; case .rollback: "arrow.counterclockwise" }
    }
}
#endif
