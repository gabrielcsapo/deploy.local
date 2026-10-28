#if os(iOS)
import SwiftUI
import DeployCore

struct V2ConversationView: View {
    @Bindable var store: V2Store
    var taskId: String?
    var agent: String? = nil
    @State private var detail: TaskDetail?
    @State private var diff: TaskDiff?
    @State private var tab = "Chat"
    @State private var compose = false
    @State private var info = false
    @State private var ship = false
    @State private var agentMenu = false
    @State private var releaseId: String?
    @State private var search = ""
    @State private var showSearch = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    private var currentId: String? { taskId ?? agent.flatMap { store.snapshot.agentTasks[$0] } }
    private var project: V2Project? { store.snapshot.projects.first { $0.id == store.tasks.first { $0.id == currentId }?.projectId } }
    private var title: String { agent?.capitalized ?? detail?.task.title ?? store.tasks.first { $0.id == taskId }?.title ?? "Conversation" }
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if agent == nil {
                    Picker("Task", selection: $tab) { Text("Chat").tag("Chat"); Text("Changes").tag("Changes"); Text("Checks").tag("Checks") }
                        .pickerStyle(.segmented).padding(.horizontal, 16).padding(.vertical, 8)
                }
                if showSearch { TextField("Search this conversation", text: $search).textFieldStyle(.roundedBorder).padding(.horizontal, 16) }
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        if tab == "Chat" { conversation }
                        else if tab == "Changes" { changes }
                        else { checks }
                        if let error { Text(error).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.danger(scheme)) }
                    }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                }.opacity(store.online ? 1 : 0.45)
                Button { compose = true } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "plus")
                        Text("Ask, build, or follow up…").font(.system(size: 15)).foregroundStyle(.secondary)
                        Spacer()
                        Image(systemName: "arrow.up.circle.fill").font(.system(size: 28))
                    }.padding(12).background(WorkspaceStyle.surface(scheme), in: Capsule()).overlay(Capsule().stroke(WorkspaceStyle.line(scheme)))
                }.padding(12)
            }.background(WorkspaceStyle.canvas(scheme)).navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { Button { dismiss() } label: { Image(systemName: "chevron.left").frame(width: 44, height: 44) }.accessibilityLabel("Back") }
                    ToolbarItem(placement: .principal) {
                        Button { info = true } label: {
                            VStack(spacing: 3) {
                                Text(title).font(.system(size: 17, weight: .semibold)).lineLimit(1)
                                if agent != nil { Text("\(store.tasks.filter { $0.status == "running" }.count) tasks running ›").font(.system(size: 12)).foregroundStyle(.secondary) }
                                else if let project { Text("\(project.name) ›").font(.system(size: 12)).foregroundStyle(.secondary) }
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
                .sheet(isPresented: $compose) { V2ComposerSheet(store: store, taskId: currentId, agent: agent ?? "scout", askingAgent: agent != nil) }
                .sheet(isPresented: $info) {
                    if let agent { V2AgentInfo(store: store, agent: agent).presentationDetents([.large]).presentationDragIndicator(.visible) }
                    else if let currentId { V2TaskInfo(store: store, taskId: currentId, detail: detail, diff: diff) { tab = $0 } }
                }
                .sheet(isPresented: $ship) { if let project, let currentId { V2ShipSheet(store: store, project: project, taskId: currentId) } }
                .sheet(isPresented: $agentMenu) { V2AgentMenu(store: store, agent: agent ?? "scout", taskURL: currentId.flatMap { URL(string: store.connection.origin + "/dashboard/tasks/" + V2Client.segment($0)) }, search: { showSearch = true }, info: { info = true }) }
                .sheet(isPresented: Binding(get: { releaseId != nil }, set: { if !$0 { releaseId = nil } })) { if let releaseId { NavigationStack { V2ReleaseDetail(store: store, releaseId: releaseId).toolbar { Button("Done") { self.releaseId = nil } } } } }
                .task(id: currentId) {
                    await load()
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
        guard let id = currentId else { return [] }
        var events = store.conversation(id)
        // Old coordinators expose message snapshots; adapt only explicit user/assistant roles.
        let known = Set(events.map(\.v2Id))
        for message in detail?.messages ?? [] where !known.contains(message.id) && message.isProgress != true {
            if message.role == "user" { events.append(.you(YouEvent(id: message.id, at: message.createdAt, text: message.content, attachments: []))) }
            else if message.role == "assistant" { events.append(.reply(ReplyEvent(id: message.id, at: message.createdAt, agent: agent ?? "scout", paragraphs: message.content.components(separatedBy: "\n\n")))) }
        }
        return events.sorted { $0.v2Date < $1.v2Date }.filter { search.isEmpty || String(describing: $0).localizedCaseInsensitiveContains(search) }
    }
    @ViewBuilder private var conversation: some View {
        if agent != nil {
            ForEach(olderDays, id: \.self) { day in
                DisclosureGroup(day) {
                    VStack(alignment: .leading, spacing: 20) { ForEach(conversationEvents.filter { dayKey($0.v2Date) == day }, id: \.v2Id) { event in eventView(event) } }
                }.font(.system(size: 13)).foregroundStyle(.secondary)
            }
            if !conversationEvents.filter({ V2Store.isToday($0.v2Date) }).isEmpty {
                Text("Today").font(.system(size: 13)).foregroundStyle(.secondary).frame(maxWidth: .infinity)
            }
        }
        ForEach(conversationEvents.filter { agent == nil || V2Store.isToday($0.v2Date) }, id: \.v2Id) { event in eventView(event) }
        // An inbox decision can precede its conversation event. Never drop that decision.
        ForEach(contextDecisions, id: \.id) { item in V2Decision(item: item, store: store) }
        if conversationEvents.isEmpty && contextDecisions.isEmpty {
            V2Empty(title: "Ask \(agent?.capitalized ?? "Scout")", message: "Ask a question or describe what you want to change.")
        }
        if detail?.runs.contains(where: \.isActive) == true {
            Label("Working · \(detail?.runs.last?.adapter.capitalized ?? "Scout")", systemImage: "arrow.trianglehead.2.clockwise.rotate.90").font(.system(size: 13)).foregroundStyle(WorkspaceStyle.active(scheme))
            Text("You’ll hear back when the task is ready, or sooner if Scout needs you. Nothing ships without your merge.").font(.system(size: 13)).foregroundStyle(.secondary)
        }
    }
    private var contextDecisions: [InboxItem] {
        let rendered = Set(conversationEvents.compactMap { event -> String? in if case .decision(let value) = event { return value.inboxItemId }; return nil })
        return store.snapshot.inbox.filter { item in
            !rendered.contains(item.id) && (agent != nil ? item.from == agent : currentId != nil && item.taskId == currentId)
        }
    }
    private var olderDays: [String] { Array(Set(conversationEvents.filter { !V2Store.isToday($0.v2Date) }.map { dayKey($0.v2Date) })).sorted() }
    private func dayKey(_ date: String) -> String { V2Labels.shortDate(date) }
    @ViewBuilder private func eventView(_ event: ConversationEvent) -> some View {
        switch event {
        case .you(let value):
            HStack { Spacer(minLength: 48); Text(value.text).font(.system(size: 17)).padding(14).background(WorkspaceStyle.selected(scheme), in: RoundedRectangle(cornerRadius: 18)) }
        case .reply(let value):
            VStack(alignment: .leading, spacing: 14) { ForEach(Array(value.paragraphs.enumerated()), id: \.offset) { _, paragraph in Text(.init(paragraph)).font(.system(size: 17)).lineSpacing(5).textSelection(.enabled) } }
        case .worklog(let value):
            DisclosureGroup(value.summary) {
                VStack(alignment: .leading, spacing: 10) { ForEach(Array(value.steps.enumerated()), id: \.offset) { _, step in Label(step.text, systemImage: step.icon == .terminal ? "terminal" : "doc").font(.system(size: 13)) } }
            }.font(.system(size: 13)).foregroundStyle(.secondary)
        case .decision(let value):
            if let item = store.snapshot.inbox.first(where: { $0.id == value.inboxItemId }) { V2Decision(item: item, store: store) }
            else { Text("Decision unavailable. Refresh Waiting on you.").font(.system(size: 13)) }
        case .task(let value):
            Button { store.selectedTaskId = value.taskId } label: { V2Row(title: store.tasks.first { $0.id == value.taskId }?.title ?? "Started a task", subtitle: "Open task", icon: "bubble.left") }
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
    private func load() async {
        guard let id = currentId, store.online else { return }
        do { detail = try await store.client.task(id); diff = try await store.client.diff(id); error = nil }
        catch { self.error = coordinatorErrorDescription(error) }
    }
}
struct V2AgentInfo: View {
    @Bindable var store: V2Store
    let agent: String
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack(spacing: 12) { V2Avatar(name: agent); VStack(alignment: .leading, spacing: 4) { Text(agent.capitalized).font(.system(size: 22, weight: .semibold)); Text(agent == "warden" ? "Watches running apps" : "Helps with your tasks").font(.system(size: 13)).foregroundStyle(.secondary) } }
                V2Group(title: "Doing now") {
                    ForEach(store.tasks.filter { ["running", "checking"].contains($0.status) }) { task in V2Row(title: task.title, subtitle: store.snapshot.workspace?.workers.first { $0.id == task.workerId }?.name, icon: "arrow.trianglehead.2.clockwise.rotate.90") }
                }
                V2Group(title: "Watching") { ForEach(store.waiting.filter { $0.from == agent }, id: \.id) { item in V2Row(title: item.title, subtitle: "Waiting for your answer", attention: true) } }
                V2Group(title: "About \(agent.capitalized)") {
                    V2Row(title: "Models", subtitle: "Defaults live in Computers › Models", icon: "cpu")
                    V2Row(title: "May do", subtitle: "View approval rules on a computer", icon: "shield")
                }
                Text("Tune, schedules and learned preferences are available on a computer.").font(.system(size: 13)).foregroundStyle(.secondary)
            }.padding(16).padding(.top, 20)
        }
    }
}
#endif
