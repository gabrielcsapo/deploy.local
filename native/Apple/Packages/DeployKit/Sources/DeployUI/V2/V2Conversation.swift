#if os(iOS)
import SwiftUI
import DeployCore

struct V2ConversationView: View {
    @Bindable var store: V2Store
    var taskId: String?
    var agent: String? = nil
    @State private var agentEvents: [ConversationEvent] = []
    @State private var suggestedText = ""
    @State private var editingItem: V2LooksAfterItem?
    @State private var history: V2LooksAfterItem?
    @State private var evidenceOpened = false
    @State private var receiptBusy = false
    @State private var detail: TaskDetail?
    @State private var diff: TaskDiff?
    @State private var tab = "Chat"
    @State private var compose = false
    @State private var info = false
    @State private var ship = false
    @State private var agentMenu = false
    @State private var approvals = false
    @State private var releaseId: String?
    @State private var search = ""
    @State private var showSearch = false
    @State private var error: String?
    /// How many boards each design review changes, for the Design tab's count.
    @State private var designBoards: [String: Int] = [:]
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    private var currentId: String? { taskId }
    private var savedAgent: V2Agent? { store.snapshot.agents.first { $0.id == agent } }
    private var project: V2Project? { store.snapshot.projects.first { $0.id == store.tasks.first { $0.id == currentId }?.projectId } }
    private var title: String { agent.map { store.agentName($0) } ?? detail?.task.title ?? store.tasks.first { $0.id == taskId }?.title ?? "Conversation" }
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if agent == nil {
                    Picker("Task", selection: $tab) {
                        Text("Chat").tag("Chat"); Text("Changes").tag("Changes")
                        if let design = designs.first { Text("Design \(designBoards[design.id] ?? 0)").tag("Design") }
                        Text("Checks").tag("Checks")
                    }
                        .pickerStyle(.segmented).padding(.horizontal, 16).padding(.vertical, 8)
                }
                if showSearch { TextField("Search this conversation", text: $search).textFieldStyle(.roundedBorder).padding(.horizontal, 16) }
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        if tab == "Chat" { conversation }
                        else if tab == "Changes" { changes }
                        else if tab == "Design" { ForEach(designs, id: \.id) { item in V2DesignCard(store: store, item: item) } }
                        else { checks }
                        if let error { Text(error).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.danger(scheme)) }
                    }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                }.opacity(store.online ? 1 : 0.45)
                if agent == nil, let currentId {
                    V2TaskComposer(store: store, taskId: currentId, expand: { compose = true })
                } else {
                    Button { compose = true } label: {
                        HStack(spacing: 12) {
                            Text("Ask, build, or follow up…").font(.system(size: 15)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
                            Spacer()
                            Image(systemName: "arrow.up.circle.fill").font(.system(size: 28)).foregroundStyle(WorkspaceStyle.text(scheme))
                        }.padding(12).background(WorkspaceStyle.surface(scheme), in: Capsule()).overlay(Capsule().stroke(WorkspaceStyle.line(scheme)))
                    }.buttonStyle(.plain).padding(12)
                }
            }.background(WorkspaceStyle.canvas(scheme)).navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { Button { dismiss() } label: { Image(systemName: "chevron.left").frame(width: 44, height: 44) }.accessibilityLabel("Back") }
                    ToolbarItem(placement: .principal) {
                        if let savedAgent {
                            Button { agentMenu.toggle() } label: { V2AgentHeader(agent: savedAgent) }.buttonStyle(.plain)
                        } else {
                            Button { info = true } label: {
                                VStack(spacing: 3) {
                                    Text(title).font(.system(size: 17, weight: .semibold)).lineLimit(1)
                                    if let project {
                                        Text("\(project.name)\(designs.contains { $0.state == .waiting } ? " · design waiting" : "") ›").font(.system(size: 12)).foregroundStyle(.secondary)
                                    }
                                }.frame(maxWidth: 230)
                            }
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        if agent != nil {
                            Button { agentMenu = true } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44) }.accessibilityLabel("Conversation menu")
                        } else {
                            Menu {
                                Button("Task info", systemImage: "info.circle") { info = true }
                                Button("Ship…", systemImage: "shippingbox") { ship = true }.disabled(project == nil || !store.online)
                                Button("Search this conversation", systemImage: "magnifyingglass") { showSearch.toggle() }
                                if let id = currentId { Button("Copy link", systemImage: "link") { UIPasteboard.general.url = URL(string: store.connection.origin + "/dashboard/tasks/" + V2Client.segment(id)) } }
                            } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44) }.accessibilityLabel("Task menu")
                        }
                    }
                }
                .sheet(isPresented: $compose) { V2ComposerSheet(store: store, taskId: currentId, agent: agent ?? "", askingAgent: agent != nil, initialText: suggestedText) }
                .sheet(item: $editingItem) { item in if let savedAgent { V2LooksAfterEditor(store: store, agent: savedAgent, item: item) } }
                .navigationDestination(isPresented: Binding(get: { history != nil }, set: { if !$0 { history = nil } })) {
                    if let history, let agent { V2AgentItemHistory(store: store, agent: agent, item: history) }
                }
                .sheet(isPresented: $approvals) { V2SettingsApprovals(store: store) }
                .sheet(isPresented: $info) {
                    if let agent { V2AgentInfo(store: store, agent: agent).presentationDetents([.large]).presentationDragIndicator(.visible) }
                    else if let currentId { V2TaskInfo(store: store, taskId: currentId, detail: detail, diff: diff) { tab = $0 } }
                }
                .sheet(isPresented: $ship) { if let project, let currentId { V2ShipSheet(store: store, project: project, taskId: currentId) } }
                .overlay(alignment: .topTrailing) {
                    if agentMenu {
                        ZStack(alignment: .topTrailing) {
                            Color.black.opacity(0.12).ignoresSafeArea().onTapGesture { agentMenu = false }
                            V2AgentMenu(
                                info: { agentMenu = false; info = true },
                                history: { agentMenu = false; history = savedAgent?.looksAfter?.first },
                                approvals: { agentMenu = false; approvals = true },
                                back: { agentMenu = false }
                            ).padding(.trailing, 12).padding(.top, 8)
                        }
                    }
                }
                .sheet(isPresented: Binding(get: { releaseId != nil }, set: { if !$0 { releaseId = nil } })) { if let releaseId { NavigationStack { V2ReleaseDetail(store: store, releaseId: releaseId).toolbar { Button("Done") { self.releaseId = nil } } } } }
                .task(id: designs.map(\.id)) {
                    for item in designs where designBoards[item.id] == nil {
                        guard let project = V2DesignReview.project(of: item.id),
                              let review = try? await store.client.designReview(project: project, item: item.id) else { continue }
                        designBoards[item.id] = review.boards.count
                    }
                }
                .task(id: currentId) {
                    await load()
                    if let board = V2Evidence.agentsBoard {
                        guard !evidenceOpened else { return }
                        evidenceOpened = true
                        switch board {
                        case .info, .infoNew, .care: info = true
                        case .menu: agentMenu = true
                        case .routine, .projects: editingItem = savedAgent?.looksAfter?.first
                        case .runs: history = savedAgent?.looksAfter?.first
                        case .mention: break
                        default: break
                        }
                        return
                    }
                    switch V2Evidence.board {
                    case "ChangesPhone": tab = "Changes"
                    case "AttachPhone", "AttachedPhone", "ModelPhone": compose = true
                    case "AgentInfoPhone", "TaskInfoPhone": info = true
                    case "ShipPhone": ship = true
                    case "AgentMenuPhone": agentMenu = true
                    default: break
                    }
                }
                .onChange(of: store.snapshot.cursor) { _, _ in Task { await load() } }
        }
    }
    private var conversationEvents: [ConversationEvent] {
        if agent != nil { return agentEvents.filter { search.isEmpty || String(describing: $0).localizedCaseInsensitiveContains(search) } }
        guard let id = currentId else { return [] }
        var events = store.conversation(id)
        // Old coordinators expose message snapshots; adapt only explicit user/assistant roles.
        let known = Set(events.map(\.v2Id))
        for message in detail?.messages ?? [] where !known.contains(message.id) && message.isProgress != true {
            if message.role == "user" { events.append(.you(YouEvent(id: message.id, at: message.createdAt, text: message.content, attachments: []))) }
            else if message.role == "assistant" { events.append(.reply(ReplyEvent(id: message.id, at: message.createdAt, agent: agent ?? "", paragraphs: message.content.components(separatedBy: "\n\n")))) }
        }
        return events.sorted { $0.v2Date < $1.v2Date }.filter { search.isEmpty || String(describing: $0).localizedCaseInsensitiveContains(search) }
    }
    @ViewBuilder private var conversation: some View {
        ForEach(savedAgent?.looksAfter?.filter { $0.confirmedAt != nil } ?? []) { item in
            Button { history = item } label: {
                (Text("Looks after: \(item.what) · \(item.recurringWhenLabel) · ").foregroundColor(WorkspaceStyle.tertiary(scheme)) + Text("History").foregroundColor(WorkspaceStyle.text(scheme)))
                    .font(.system(size: 13)).frame(minHeight: 44, alignment: .leading)
            }.buttonStyle(.plain)
        }
        if let savedAgent, agentEvents.isEmpty {
            VStack(spacing: 16) {
                AgentAvatar(glyph: savedAgent.identity.glyph, color: savedAgent.identity.color, size: 88)
                Text(savedAgent.name).font(.system(size: 22, weight: .semibold))
                Text("Tell \(savedAgent.name) what you want it to do. It remembers.").font(.system(size: 17)).multilineTextAlignment(.center)
                VStack(spacing: 8) {
                ForEach(["Draft release notes for what merged each week", "Watch my apps and tell me when something fails", "Review my open pull requests", "Research a question for me"], id: \.self) { text in
                    Button { suggestedText = text; compose = true } label: {
                        Text(text).font(.system(size: 15)).multilineTextAlignment(.leading)
                            .padding(.horizontal, 14).padding(.vertical, 10).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: 10))
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(WorkspaceStyle.line(scheme)))
                    }.buttonStyle(.plain)
                }
                }
            }.padding(.vertical, 32).frame(maxWidth: .infinity)
        }
        if agent != nil {
            ForEach(olderDays, id: \.self) { day in
                DisclosureGroup(day) {
                    VStack(alignment: .leading, spacing: 20) { ForEach(conversationEvents.filter { dayKey($0.v2Date) == day }, id: \.v2Id) { event in eventView(event) } }
                }.font(.system(size: 13)).foregroundStyle(.secondary)
            }
        }
        ForEach(conversationEvents.filter { agent == nil || V2Evidence.isToday($0.v2Date) }, id: \.v2Id) { event in eventView(event) }
        // An inbox decision can precede its conversation event. Never drop that decision.
        ForEach(contextDecisions, id: \.id) { item in decisionView(item) }
        if detail?.runs.contains(where: \.isActive) == true {
            Label("Working · \(detail?.runs.last?.adapter.capitalized ?? "Agent")", systemImage: "arrow.trianglehead.2.clockwise.rotate.90").font(.system(size: 13)).foregroundStyle(WorkspaceStyle.active(scheme))
            Text("You’ll hear back when the task is ready, or sooner if your input is needed. Nothing ships without your merge.").font(.system(size: 13)).foregroundStyle(.secondary)
        }
    }
    private var contextDecisions: [InboxItem] {
        let rendered = Set(conversationEvents.compactMap { event -> String? in if case .decision(let value) = event { return value.inboxItemId }; return nil })
        return store.snapshot.inbox.filter { item in
            !rendered.contains(item.id) && (agent != nil ? item.from == agent : currentId != nil && item.taskId == currentId)
        }
    }
    /// A design waiting on you shows its boards; any other decision its card.
    @ViewBuilder private func decisionView(_ item: InboxItem) -> some View {
        if V2DesignReview.project(of: item.id) != nil { V2DesignCard(store: store, item: item) }
        else { V2Decision(item: item, store: store) }
    }
    /// This task's design reviews, newest first.
    private var designs: [InboxItem] {
        guard let currentId else { return [] }
        return store.snapshot.inbox.filter { $0.taskId == currentId && V2DesignReview.project(of: $0.id) != nil && $0.state != .withdrawn }
    }
    private var olderDays: [String] { Array(Set(conversationEvents.filter { !V2Evidence.isToday($0.v2Date) }.map { dayKey($0.v2Date) })).sorted() }
    private func dayKey(_ date: String) -> String { V2Evidence.shortDate(date) }
    @ViewBuilder private func eventView(_ event: ConversationEvent) -> some View {
        switch event {
        case .you(let value):
            HStack { Spacer(minLength: 48); Text(value.text).font(.system(size: 17)).padding(14).background(WorkspaceStyle.selected(scheme), in: RoundedRectangle(cornerRadius: 18)) }
        case .reply(let value):
            if let savedAgent { HStack { AgentAvatar(glyph: savedAgent.identity.glyph, color: savedAgent.identity.color); Text(savedAgent.name).font(.system(size: 13)).lineLimit(1) } }
            VStack(alignment: .leading, spacing: 14) {
                ForEach(Array(value.paragraphs.enumerated()), id: \.offset) { _, paragraph in
                    Text(.init(paragraph + (paragraph.contains("outside this agent’s project access") || paragraph.contains("outside this agent's project access") ? " [Review access](deploy-agent://access)" : "")))
                        .font(.system(size: 17)).lineSpacing(5).textSelection(.enabled)
                        .environment(\.openURL, OpenURLAction { url in
                            if url.scheme == "deploy-agent" { info = true; return .handled }
                            return .systemAction
                        })
                }
            }
            ForEach(Array((value.receipts ?? []).enumerated()), id: \.offset) { _, receipt in
                if receipt.kind == "job" { HStack { Text("Saved to What it does ·"); Button("Edit") { info = true } }.font(.system(size: 13)).foregroundStyle(.secondary) }
                else if let item = savedAgent?.looksAfter?.first(where: { $0.id == receipt.itemId }) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.confirmedAt == nil ? "Now looks after: \(item.what) · \(item.summary(projects: store.snapshot.projects))" : "Confirmed · first check \(item.whenLabel)")
                        HStack {
                            if item.confirmedAt == nil { Button("Confirm") { confirm(item) }.buttonStyle(V2PrimaryButtonStyle(inline: true)).disabled(receiptBusy) }
                            Text("·").foregroundStyle(.secondary)
                            Button("Edit") { editingItem = item }.buttonStyle(.plain).foregroundStyle(WorkspaceStyle.text(scheme))
                        }
                    }.font(.system(size: 13)).foregroundStyle(.secondary)
                }
            }
        case .worklog(let value):
            DisclosureGroup(value.summary) {
                VStack(alignment: .leading, spacing: 10) { ForEach(Array(value.steps.enumerated()), id: \.offset) { _, step in Label(step.text, systemImage: step.icon == .terminal ? "terminal" : "doc").font(.system(size: 13)) } }
            }.font(.system(size: 13)).foregroundStyle(.secondary)
        case .decision(let value):
            if let item = store.snapshot.inbox.first(where: { $0.id == value.inboxItemId }) { decisionView(item) }
            else { Text("Decision unavailable. Refresh Waiting on you.").font(.system(size: 13)) }
        case .task(let value):
            Button { store.selectedTaskId = value.taskId } label: {
                V2Group { V2Row(title: store.tasks.first { $0.id == value.taskId }?.title ?? "Started a task", subtitle: taskSummary(value.taskId, at: value.at), identity: savedAgent?.identity, chevron: true) }
            }.buttonStyle(.plain)
        case .release(let value):
            Button { releaseId = value.releaseId } label: { V2Row(title: "Release \(value.releaseId.prefix(7))", subtitle: "View release", icon: "shippingbox") }
        case .screenshot:
            V2Row(title: "Screenshot", subtitle: "Open on a computer", icon: "photo")
        case .report(let value):
            VStack(alignment: .leading, spacing: 12) { Text(value.title).font(.system(size: 17, weight: .medium)); ForEach(Array(value.sections.enumerated()), id: \.offset) { _, section in Text(section.title).font(.system(size: 15, weight: .medium)); Text(section.body).font(.system(size: 17)) } }
        }
    }
    @ViewBuilder private var changes: some View {
        if let diff {
            Text("\(diff.files.count) files").font(.system(size: 13)).foregroundStyle(.secondary)
            V2Group { ForEach(diff.files) { file in V2Row(title: URL(fileURLWithPath: file.path).lastPathComponent, subtitle: file.path, icon: "doc", trailing: file.status) } }
            Text(diff.patch).font(.system(size: 12, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        } else { V2Empty(title: "No changes yet", message: "Files appear here as the task changes them.") }
    }
    @ViewBuilder private var checks: some View {
        if let diff, !diff.checks.isEmpty {
            ForEach(Array(diff.checks.enumerated()), id: \.offset) { _, check in Text(check.prettyText).font(.system(size: 13, design: .monospaced)).textSelection(.enabled) }
        } else { V2Empty(title: "No checks yet", message: "Check results appear here when they run.") }
    }
    private func taskSummary(_ id: String, at: String) -> String {
        let task = store.tasks.first { $0.id == id }
        let computer = store.snapshot.computers.first { $0.id == task?.workerId }?.name ?? store.snapshot.workspace?.workers.first { $0.id == task?.workerId }?.name
        let status = task?.status.capitalized ?? "Running"
        let time = V2Evidence.shortDate(at)
        return "Task · \(status)\(computer.map { " on " + $0 } ?? "") · \(time == "now" ? "just now" : time)"
    }
    private func confirm(_ item: V2LooksAfterItem) {
        guard let agent, !receiptBusy else { return }; receiptBusy = true
        Task { defer { receiptBusy = false }; do { store.updateAgent(try await store.client.confirmAgentItem(agent, item: item.id)) } catch { self.error = coordinatorErrorDescription(error) } }
    }
    private func load() async {
        if let agent {
            do { agentEvents = try await store.client.agentConversation(agent).events; error = nil } catch { self.error = coordinatorErrorDescription(error) }
            return
        }
        guard let id = currentId, store.online else { return }
        do { detail = try await store.client.task(id); diff = try await store.client.diff(id); error = nil }
        catch { self.error = coordinatorErrorDescription(error) }
    }
}
#endif
