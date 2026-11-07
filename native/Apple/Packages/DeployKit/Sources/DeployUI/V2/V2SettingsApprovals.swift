#if os(iOS)
import SwiftUI
import DeployCore

struct V2SettingsApprovals: View {
    @Bindable var store: V2Store
    @State private var read = V2Read<V2Approvals>()
    private var approvals: V2Approvals? { read.value }
    @State private var selected: V2Agent?
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    V2LoadNotice(state: read.state, copy: .resource("Approvals"), lastHeard: store.readDates["approvals"], retry: { await load() })
                    V2LoadRegion(state: store.loadState("agents"), copy: .resource("Approvals"), lastHeard: store.snapshot.resourceDates["agents"], retry: { await store.refreshResources(["agents"]) }) {
                        V2SettingsGroup(list: true, title: "Agents", note: "Action rules are read-only here; change them on a computer.") {
                            ForEach(store.snapshot.agents) { agent in
                                Button { selected = agent } label: { V2SettingsRow(list: true, title: agent.name, subtitle: approvals == nil ? nil : summary(agent), identity: agent.identity) { if read.state.showsSkeleton { V2Skeleton(width: 90, height: 10) }; V2SettingsChevron() } }
                            }
                            if store.snapshot.agents.isEmpty { V2SettingsRow(list: true, title: "No agents", icon: "person") { EmptyView() } }
                            if let error { Text(error).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.danger(scheme)) }
                        }
                    }
                }.padding(16)
            }.background(WorkspaceStyle.canvas(scheme)).navigationTitle("What agents may do").navigationBarTitleDisplayMode(.inline).toolbar { Button("Done") { dismiss() } }
                .sheet(item: $selected, onDismiss: { Task { await load() } }) { V2AgentRules(store: store, agent: $0) }
                .loadingHeader(title: "What agents may do", read.state, store.loadState("agents"))
                .onDisappear { read.leave(); store.leaveResources(["agents"]) }
                .refreshable { await load() }
                .task {
                    async let agents: Void = store.refreshResources(["agents"])
                    await load()
                    _ = await agents
                    if V2Evidence.agentsBoard == .rules { selected = store.snapshot.agents.first { $0.id == "release-notes-writer" } }
                }
        }
    }
    private func summary(_ agent: V2Agent) -> String {
        guard let approvals else { return "Unavailable" }
        return approvals.summary(agent: agent.id)
    }
    private func load() async { await read.load(store: store, key: "approvals") { try await store.client.approvals() } }
}
struct V2AgentRules: View {
    @Bindable var store: V2Store
    let agent: V2Agent
    @State private var read = V2Read<V2Approvals>()
    private var approvals: V2Approvals? { read.value }
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    V2LoadNotice(state: read.state, copy: .resource("Approvals"), lastHeard: store.readDates["approvals"], retry: { await load() })
                    V2SettingsGroup(list: true, title: "What it may do", note: "Merging and rolling back always show you what changes first.\n\nRules are edited on a computer.") {
                        ForEach(V2ApprovalAction.allCases, id: \.self) { action in
                            V2SettingsRow(list: true, title: action.label, subtitle: explanation(action), icon: icon(action), glyph: action == .openPullRequest ? .pullRequest : nil) {
                                if let approvals { Text(approvals.mode(agent: agent.id, action: action).label).font(.system(size: 15)).foregroundStyle(WorkspaceStyle.tertiary(scheme)) }
                                else if read.state.showsSkeleton { V2Skeleton(width: 90, height: 10) }
                            }
                        }
                        if let error { Text(error).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.danger(scheme)) }
                    }
                }.padding(16)
            }.background(WorkspaceStyle.canvas(scheme)).navigationTitle(agent.name).navigationBarTitleDisplayMode(.inline).toolbar { Button("Done") { dismiss() } }
                .task { await load() }.refreshable { await load() }
                .loadingHeader(title: agent.name, read.state).onDisappear { read.leave() }
        }
    }
    private func load() async { await read.load(store: store, key: "approvals") { try await store.client.approvals() } }
    private func explanation(_ action: V2ApprovalAction) -> String {
        switch action { case .startTask: "Work on a branch inside its limits"; case .openPullRequest: "Bring a branch for review"; case .merge: "Apply a reviewed change"; case .restart: "Stop and start the running app"; case .rollback: "Restore the previous release" }
    }
    private func icon(_ action: V2ApprovalAction) -> String {
        switch action { case .startTask: "list.clipboard"; case .openPullRequest: "arrow.triangle.branch"; case .merge: "arrow.triangle.merge"; case .restart: "arrow.clockwise"; case .rollback: "arrow.counterclockwise" }
    }
}
#endif
