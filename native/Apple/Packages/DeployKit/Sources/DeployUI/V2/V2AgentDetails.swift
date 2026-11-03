#if os(iOS)
import SwiftUI
import DeployCore

struct V2AgentInfo: View {
    @Bindable var store: V2Store
    let agent: String
    @State private var name = ""
    @State private var job = ""
    @State private var avatar = V2AgentAvatar.random()
    @State private var project = ""
    @State private var computers = ""
    @State private var editJob = false
    @State private var editingItem: V2LooksAfterItem?
    @State private var history: V2LooksAfterItem?
    @State private var rules = false
    @State private var approvals: V2Approvals?
    @State private var deleting = false
    @State private var busy = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    private var saved: V2Agent? { store.snapshot.agents.first { $0.id == agent } }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    V2AgentIdentity(avatar: $avatar)
                    Text("Name").font(.system(size: 13)).foregroundStyle(.secondary)
                    TextField("Name", text: $name).textFieldStyle(.roundedBorder)
                    VStack(alignment: .leading, spacing: 8) {
                        Text("What it does").font(.system(size: 13)).foregroundStyle(.secondary)
                        HStack { Text(job.isEmpty ? "Tell it what you want it to do in chat" : "Learned from your messages"); Button("Edit") { editJob.toggle() } }.font(.system(size: 13))
                        if editJob { TextEditor(text: $job).frame(minHeight: 140).overlay(RoundedRectangle(cornerRadius: 8).stroke(WorkspaceStyle.line(scheme))) }
                        else { Text(job).font(.system(size: 17)) }
                        Text("Changes apply to future replies and work. Existing messages stay as they were.").font(.system(size: 13)).foregroundStyle(.secondary)
                    }
                    V2SettingsGroup(list: true, title: "What it’s learned", note: "Lessons come from your answers. It asks before keeping anything it worked out itself.") {
                        V2SettingsRow(list: true, title: "Nothing learned yet. It learns from how you answer its work.", icon: "lightbulb") { EmptyView() }
                    }
                    V2SettingsGroup(list: true, title: "Looks after") {
                        ForEach(saved?.looksAfter ?? []) { item in
                            Button { editingItem = item } label: { V2SettingsRow(list: true, title: item.what, subtitle: item.summary(projects: store.snapshot.projects), icon: "clock") { V2SettingsChevron() } }
                            HStack { Button("History") { history = item }; Text(item.confirmedAt == nil ? "Starts after you confirm" : "Confirmed · Next \(item.whenLabel)").foregroundStyle(.secondary) }.font(.system(size: 13)).padding(.horizontal, 16).frame(minHeight: 44)
                        }
                        if saved?.looksAfter?.isEmpty != false { V2SettingsRow(list: true, title: "Nothing to look after yet", subtitle: "Add something in chat", icon: "bubble.left") { EmptyView() } }
                        Button { editingItem = V2LooksAfterItem() } label: { V2SettingsRow(list: true, title: "Add", icon: "plus") { V2SettingsChevron() } }
                    }
                    V2SettingsGroup(list: true, title: "What it may use") {
                        V2SettingsRow(list: true, title: "Project", subtitle: "Choose one project, or no project", icon: "folder") {
                            Picker("Works in", selection: $project) { Text("No project").tag(""); ForEach(store.snapshot.projects) { Text($0.name).tag($0.id) } }.labelsHidden()
                        }
                        V2SettingsRow(list: true, title: "Computers", subtitle: "Where its tasks can run", icon: "desktopcomputer") { TextField("Computers", text: $computers).multilineTextAlignment(.trailing) }
                    }
                    V2SettingsGroup(list: true, title: "Approvals", note: "Merging and rolling back always show you what changes first.") {
                        Button { rules = true } label: { V2SettingsRow(list: true, title: "Approvals", subtitle: approvalSummary, icon: "shield") { V2SettingsChevron() } }
                    }
                    V2SettingsGroup(list: true, note: "Its Looks after items and approval rules go with it. Tasks it already started stay in your task list.") {
                        Button(role: .destructive) { deleting = true } label: { V2SettingsRow(list: true, title: "Delete \(name)", icon: "trash") { EmptyView() } }
                    }
                    if let error { Text(error).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.danger(scheme)) }
                }.padding(16)
            }.background(WorkspaceStyle.canvas(scheme)).navigationTitle("Agent details").navigationBarTitleDisplayMode(.inline).toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .topBarTrailing) { Button("Save") { save() }.disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
            }
            .sheet(item: $editingItem) { item in if let saved { V2LooksAfterEditor(store: store, agent: saved, item: item) } }
            .sheet(item: $history) { item in V2AgentItemHistory(store: store, agent: agent, item: item) }
            .sheet(isPresented: $rules) { if let saved { V2AgentRules(store: store, agent: saved) } }
            .confirmationDialog("Delete \(name)?", isPresented: $deleting, titleVisibility: .visible) { Button("Delete", role: .destructive) { remove() } }
            .task { approvals = try? await store.client.approvals() }
            .onAppear { if let saved { name = saved.name; job = saved.job ?? ""; avatar = saved.identity; project = saved.projectId ?? ""; computers = (saved.computers ?? []).joined(separator: ", ") } }
        }
    }
    private var approvalSummary: String {
        guard let approvals else { return "Unavailable" }
        if V2ApprovalAction.allCases.allSatisfy({ approvals.mode(agent: agent, action: $0) == .ask }) { return "Asks before every action" }
        return V2ApprovalAction.allCases.map { "\($0.label): \(approvals.mode(agent: agent, action: $0).label)" }.joined(separator: " · ")
    }
    private func save() {
        busy = true; error = nil
        Task { defer { busy = false }; do { store.updateAgent(try await store.client.editAgent(agent, values: .init(name: name, job: job, avatar: avatar, projectId: project, computers: computers.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }))); dismiss() } catch { self.error = coordinatorErrorDescription(error) } }
    }
    private func remove() {
        busy = true
        Task { defer { busy = false }; do { try await store.client.deleteAgent(agent); await store.refresh(); dismiss() } catch { self.error = coordinatorErrorDescription(error) } }
    }
}
struct V2LooksAfterEditor: View {
    @Bindable var store: V2Store
    let agent: V2Agent
    @State var item: V2LooksAfterItem
    @State private var busy = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    private let days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    private var scope: Binding<String> { Binding(get: { item.where.label }, set: { item.where = $0 == "All Active" ? .allActive : $0 == "All Active and Maintained" ? .activeAndMaintained : .projects([]) }) }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("What").font(.system(size: 13)).foregroundStyle(.secondary)
                    TextEditor(text: $item.what).frame(minHeight: 120).overlay(RoundedRectangle(cornerRadius: 8).stroke(WorkspaceStyle.line(scheme)))
                    V2SettingsGroup(list: true, title: "Where", note: "Choosing a project never grants access.") {
                        V2SettingsRow(list: true, title: "Where", icon: "folder") { Picker("Where", selection: scope) { ForEach(["All Active", "All Active and Maintained", "Chosen projects"], id: \.self) { Text($0).tag($0) } }.labelsHidden() }
                        if case .projects(let ids) = item.where {
                            ForEach(store.snapshot.projects) { project in
                                Toggle(isOn: Binding(get: { ids.contains(project.id) }, set: { selected in item.where = .projects(selected ? ids + [project.id] : ids.filter { $0 != project.id }) })) {
                                    VStack(alignment: .leading) { Text(project.name).font(.system(size: 17)); Text(agent.projectId == nil || agent.projectId == project.id ? "Access granted" : "Needs access").font(.system(size: 13)).foregroundStyle(.secondary) }
                                }.padding(.horizontal, 16).frame(minHeight: 64)
                            }
                        }
                    }
                    V2SettingsGroup(list: true, title: "When", note: "On \(store.snapshot.computers.first { $0.id == "coordinator" }?.name ?? "the coordinator")’s clock") {
                        V2SettingsRow(list: true, title: "When", icon: "clock") { Picker("When", selection: $item.when.every) { Text("Every week").tag("week"); Text("Every day").tag("day"); Text("On each change").tag("change") }.labelsHidden() }
                        if item.when.every == "week" { V2SettingsRow(list: true, title: "Day", icon: "calendar") { Picker("Day", selection: Binding(get: { item.when.day ?? 1 }, set: { item.when.day = $0 })) { ForEach(0..<7, id: \.self) { Text(days[$0]).tag($0) } }.labelsHidden() } }
                        if item.when.every != "change" { V2SettingsRow(list: true, title: "Time", icon: "clock") { TextField("HH:MM", text: $item.when.time).multilineTextAlignment(.trailing).keyboardType(.numbersAndPunctuation) } }
                    }
                    V2SettingsGroup(list: true, title: "Brings", note: "Proposed from your message. Starts after you confirm. Uses this agent’s access and approval rules.") {
                        V2SettingsRow(list: true, title: "Brings", icon: "bubble.left") { Picker("Brings", selection: $item.brings) { ForEach(["pull-request", "design-review", "question", "message"], id: \.self) { Text("A \($0.replacingOccurrences(of: "-", with: " "))").tag($0) } }.labelsHidden() }
                    }
                    if let error { Text(error).foregroundStyle(WorkspaceStyle.danger(scheme)).font(.system(size: 13)) }
                    Button("Confirm item") { confirm() }.buttonStyle(.borderedProminent).tint(WorkspaceStyle.text(scheme)).disabled(busy || item.what.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }.padding(16)
            }.background(WorkspaceStyle.canvas(scheme)).navigationTitle("Looks after").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() }.disabled(busy) } }
        }
    }
    private func confirm() {
        guard !busy else { return }; busy = true; error = nil
        Task { defer { busy = false }; do {
            let current = try await store.client.agents().first { $0.id == agent.id }
            if current?.looksAfter?.contains(where: { $0.id == item.id }) != true { item.when.timezone = try await store.client.agentTimezone() }
            let items = (current?.looksAfter ?? []).filter { $0.id != item.id } + [item]
            _ = try await store.client.editAgent(agent.id, values: .init(looksAfter: items))
            store.updateAgent(try await store.client.confirmAgentItem(agent.id, item: item.id)); dismiss()
        } catch { self.error = coordinatorErrorDescription(error) } }
    }
}
struct V2AgentItemHistory: View {
    @Bindable var store: V2Store
    let agent: String
    let item: V2LooksAfterItem
    @State private var runs: [V2AgentRun]?
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack { ScrollView { V2SettingsGroup(list: true, title: item.what) {
            if let runs { if runs.isEmpty { V2SettingsRow(list: true, title: "No runs yet", icon: "clock") { EmptyView() } }; ForEach(runs) { run in Button { store.selectedTaskId = run.id; dismiss() } label: { V2SettingsRow(list: true, title: run.title, subtitle: "\(run.status) · \(V2Evidence.shortDate(run.at))", icon: "bubble.left") { V2SettingsChevron() } } } }
            if let error { Text(error).font(.system(size: 13)) }
                    Button("Run now") { Task { do { store.selectedTaskId = try await store.client.runAgentItem(agent, item: item.id); dismiss() } catch { self.error = coordinatorErrorDescription(error) } } }.disabled(item.confirmedAt == nil)
        }.padding(16) }.navigationTitle("History").toolbar { Button("Done") { dismiss() } }.task { do { runs = try await store.client.agentItemRuns(agent, item: item.id) } catch { self.error = coordinatorErrorDescription(error) } } }
    }
}
#endif
