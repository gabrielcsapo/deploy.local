#if os(iOS)
import SwiftUI
import DeployCore

struct V2AgentInfo: View {
    @Bindable var store: V2Store
    let agent: String
    @State private var detailsRead = V2Read<V2Agent>()
    @State private var loaded = false
    @State private var name = ""
    @State private var job = ""
    @State private var avatar = V2AgentAvatar.random()
    @State private var project = ""
    @State private var computers = ""
    @FocusState private var editJob: Bool
    @State private var editingItem: V2LooksAfterItem?
    @State private var history: V2LooksAfterItem?
    @State private var rules = false
    @State private var approvalsRead = V2Read<V2Approvals>()
    private var approvals: V2Approvals? { approvalsRead.value }
    @State private var deleting = false
    @State private var busy = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    private var saved: V2Agent? { detailsRead.value ?? store.snapshot.agents.first { $0.id == agent } }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    V2LoadRegion(state: detailsRead.state, copy: .resource("Agent details"), lastHeard: store.readDates["agent:" + agent], retry: { await loadDetails() }) {
                        V2AgentIdentity(avatar: $avatar)
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Name").font(.system(size: 13)).foregroundStyle(.secondary)
                            TextField("Name", text: $name).textFieldStyle(.roundedBorder)
                        }
                        VStack(alignment: .leading, spacing: 8) {
                            Text("What it does").font(.system(size: 13)).foregroundStyle(.secondary)
                            HStack { Text(job.isEmpty ? "Tell it what you want it to do in chat ·" : "Learned from your messages ·").foregroundStyle(.secondary); Button("Edit") { editJob = true } }.font(.system(size: 13))
                            TextEditor(text: $job).font(.system(size: 17)).focused($editJob).scrollContentBackground(.hidden)
                                .padding(8).frame(height: 156).background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: 8))
                                .overlay(RoundedRectangle(cornerRadius: 8).stroke(WorkspaceStyle.line(scheme)))
                            Text("Changes apply to future replies and work. Existing messages stay as they were.").font(.system(size: 13)).foregroundStyle(.secondary)
                        }
                        V2SettingsGroup(list: true, title: "What it's learned", note: "Lessons come from your answers. It asks before keeping anything it worked out itself.") {
                            V2SettingsRow(list: true, title: "Nothing learned yet. It learns from how you answer its work.", icon: nil) { EmptyView() }
                        }
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Looks after").font(.system(size: 13)).foregroundStyle(.secondary)
                                    if saved?.looksAfter?.isEmpty == false { Text("What · where · when · brings").font(.system(size: 13)).foregroundStyle(.secondary) }
                                }
                                Spacer()
                                if saved?.looksAfter?.isEmpty == false { Button("Add") { editingItem = V2LooksAfterItem() }.font(.system(size: 15)).frame(minHeight: 44) }
                            }
                            V2Group {
                                ForEach(saved?.looksAfter ?? []) { item in
                                    Button { editingItem = item } label: { V2SettingsRow(list: true, title: item.what, subtitle: item.summary(projects: store.snapshot.projects), icon: nil) { V2SettingsChevron() } }
                                    HStack { Button("History") { history = item }; Text(item.confirmedAt == nil ? "· Starts after you confirm" : "· Confirmed · Next \(item.whenLabel)").foregroundStyle(.secondary) }.font(.system(size: 13)).padding(.horizontal, 16).frame(minHeight: 44)
                                }
                                if saved?.looksAfter?.isEmpty != false {
                                    Button { dismiss() } label: { V2SettingsRow(list: true, title: "Nothing to look after yet", subtitle: "Add something in chat", icon: nil) { V2SettingsChevron() } }
                                }
                            }
                        }
                        V2SettingsGroup(list: true, title: "What it may use") {
                            V2SettingsRow(list: true, title: "Project", subtitle: "Choose one project, or no project", icon: "folder") {
                                Picker("Works in", selection: $project) { Text("No project").tag(""); ForEach(store.snapshot.projects) { Text($0.name).tag($0.id) } }.labelsHidden()
                            }
                            V2SettingsRow(list: true, title: "Computers", subtitle: "Where its tasks can run", icon: "desktopcomputer") { TextField("Computers", text: $computers).multilineTextAlignment(.trailing) }
                        }
                        V2LoadNotice(state: approvalsRead.state, copy: .resource("Approvals"), lastHeard: store.readDates["approvals"], retry: { await loadApprovals() })
                        V2SettingsGroup(list: true, title: "Approvals", note: "Merging and rolling back always show you what changes first.") {
                            Button { rules = true } label: { V2SettingsRow(list: true, title: "Approvals", subtitle: approvals == nil ? nil : approvalSummary, icon: "shield") { if approvalsRead.state.showsSkeleton { V2Skeleton(width: 90, height: 10) }; V2SettingsChevron() } }
                        }
                        V2SettingsGroup(list: true, title: "Delete", note: "Its Looks after items and approval rules go with it. Tasks it already started stay in your task list.") {
                            Button(role: .destructive) { deleting = true } label: { V2SettingsRow(list: true, title: "Delete \(name)", icon: "trash") { EmptyView() } }
                        }
                    }
                    if let error { Text(error).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.danger(scheme)) }
                }.padding(16)
            }.background(WorkspaceStyle.canvas(scheme)).navigationTitle("Agent details").navigationBarTitleDisplayMode(.inline).toolbar {
                ToolbarItem(placement: .topBarLeading) { Button { dismiss() } label: { Image(systemName: "chevron.left").frame(width: 44, height: 44) }.accessibilityLabel("Back").disabled(busy) }
                ToolbarItem(placement: .topBarTrailing) { Button("Save") { save() }.disabled(!loaded || busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
            }
            .sheet(item: $editingItem) { item in if let saved { V2LooksAfterEditor(store: store, agent: saved, item: item) } }
            .navigationDestination(isPresented: Binding(get: { history != nil }, set: { if !$0 { history = nil } })) {
                if let history { V2AgentItemHistory(store: store, agent: agent, item: history) }
            }
            .sheet(isPresented: $rules) { if let saved { V2AgentRules(store: store, agent: saved) } }
            .confirmationDialog("Delete \(name)?", isPresented: $deleting, titleVisibility: .visible) { Button("Delete", role: .destructive) { remove() } }
            .task(id: agent) {
                initialize()
                async let details: Void = loadDetails()
                async let rules: Void = loadApprovals()
                _ = await (details, rules)
            }
            .onChange(of: saved) { _, _ in initialize() }
            .loadingHeader(title: "Agent details", detailsRead.state, approvalsRead.state)
            .onDisappear { detailsRead.leave(); approvalsRead.leave() }
        }
    }
    private func initialize() {
        guard !loaded, let saved else { return }
        loaded = true; name = saved.name; job = saved.job ?? ""; avatar = saved.identity
        project = saved.projectId ?? ""; computers = (saved.computers ?? []).joined(separator: ", ")
    }
    private func loadDetails() async {
        await detailsRead.load(store: store, key: "agent:" + agent, initial: saved) {
            guard let next = try await store.client.agents().first(where: { $0.id == agent }) else { throw ClientError.invalidResponse }
            return next
        }
        initialize()
    }
    private func loadApprovals() async { await approvalsRead.load(store: store, key: "approvals") { try await store.client.approvals() } }
    private var approvalSummary: String {
        guard let approvals else { return "Unavailable" }
        if V2ApprovalAction.allCases.allSatisfy({ approvals.mode(agent: agent, action: $0) == .ask }) { return "Asks before every action" }
        return approvals.summary(agent: agent)
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
    private var computerName: String { store.snapshot.computers.first { $0.id == "coordinator" }?.name ?? "the coordinator" }
    private func hasAccess(_ project: V2Project) -> Bool {
        V2Evidence.projectAccess(agent: agent, project: project) ?? (agent.projectId == nil || agent.projectId == project.id)
    }
    private var accessNote: String {
        if let note = V2Evidence.projectAccessNote(agent: agent) { return note }
        if let id = agent.projectId {
            let name = store.snapshot.projects.first { $0.id == id }?.name ?? id
            return "Only \(name) is within this agent’s access. Choosing a project never grants access. Done projects are excluded."
        }
        return "Choosing a project never grants access. Done projects are excluded."
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    fieldLabel("What")
                    TextEditor(text: $item.what).font(.system(size: 17)).scrollContentBackground(.hidden).padding(8).frame(height: 132)
                        .background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(WorkspaceStyle.line(scheme)))
                    fieldLabel("Where")
                    fieldPicker("Where", selection: scope, values: ["All Active", "All Active and Maintained", "Chosen projects"])
                    if case .projects(let ids) = item.where {
                        V2Group {
                            ForEach(store.snapshot.projects.filter { $0.stage?.lowercased() != "done" }) { project in
                                Button {
                                    item.where = .projects(ids.contains(project.id) ? ids.filter { $0 != project.id } : ids + [project.id])
                                } label: {
                                    HStack {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(project.name).font(.system(size: 17))
                                            Text("\(V2Evidence.projectStage(project)) · \(hasAccess(project) ? "Access granted" : "Needs access")").font(.system(size: 13)).foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        Image(systemName: ids.contains(project.id) ? "checkmark.square.fill" : "square").font(.system(size: 20))
                                            .foregroundStyle(hasAccess(project) ? WorkspaceStyle.text(scheme) : WorkspaceStyle.tertiary(scheme))
                                    }.padding(.horizontal, 12).frame(minHeight: 64).contentShape(Rectangle())
                                }.buttonStyle(.plain).disabled(!hasAccess(project))
                                    .accessibilityLabel("Look after " + project.name).accessibilityAddTraits(ids.contains(project.id) ? .isSelected : [])
                            }
                        }
                    }
                    Text(accessNote).font(.system(size: 13)).foregroundStyle(.secondary).padding(.bottom, 8)
                    fieldLabel("When")
                    Picker("When", selection: $item.when.every) { Text("Every week").tag("week"); Text("Every day").tag("day"); Text("On each change").tag("change") }.pickerStyle(.menu).labelsHidden().modifier(AgentField())
                    if item.when.every == "week" {
                        fieldLabel("Day")
                        Picker("Day", selection: Binding(get: { item.when.day ?? 1 }, set: { item.when.day = $0 })) { ForEach([1, 2, 3, 4, 5, 6, 0], id: \.self) { Text(days[$0]).tag($0) } }.pickerStyle(.menu).labelsHidden().modifier(AgentField())
                    }
                    if item.when.every != "change" {
                        fieldLabel("Time")
                        TextField("HH:MM", text: $item.when.time).keyboardType(.numbersAndPunctuation).modifier(AgentField())
                        Text("On \(computerName)'s clock").font(.system(size: 13)).foregroundStyle(.secondary).padding(.bottom, 8)
                    }
                    fieldLabel("Brings")
                    Picker("Brings", selection: $item.brings) { ForEach(["pull-request", "design-review", "question", "message"], id: \.self) { Text("A \($0.replacingOccurrences(of: "-", with: " "))").tag($0) } }.pickerStyle(.menu).labelsHidden().modifier(AgentField())
                    Text(V2Evidence.itemConfirmationNote ?? "Proposed from your message. Starts after you confirm. Uses this agent’s access and approval rules.").font(.system(size: 13)).foregroundStyle(.secondary).padding(.top, 8)
                    if let error { Text(error).foregroundStyle(WorkspaceStyle.danger(scheme)).font(.system(size: 13)) }
                }.padding(20)
            }.safeAreaInset(edge: .bottom) {
                VStack(spacing: 8) {
                    Button("Confirm item") { confirm() }.buttonStyle(V2PrimaryButtonStyle()).disabled(busy || item.what.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button { dismiss() } label: { Text("Cancel").frame(maxWidth: .infinity, minHeight: 44).overlay(RoundedRectangle(cornerRadius: 10).stroke(WorkspaceStyle.line(scheme))) }.buttonStyle(.plain).disabled(busy)
                }.padding(20).background(WorkspaceStyle.surface(scheme))
            }.background(WorkspaceStyle.canvas(scheme)).navigationTitle("Looks after").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { dismiss() } label: { Image(systemName: "xmark").frame(width: 44, height: 44) }.accessibilityLabel("Close").disabled(busy) } }
        }.presentationDetents([.height(620), .large]).presentationDragIndicator(.visible)
    }
    private func fieldLabel(_ title: String) -> some View { Text(title).font(.system(size: 13)).foregroundStyle(.secondary) }
    private func fieldPicker(_ title: String, selection: Binding<String>, values: [String]) -> some View {
        Picker(title, selection: selection) { ForEach(values, id: \.self) { Text($0).tag($0) } }.pickerStyle(.menu).labelsHidden().modifier(AgentField())
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
private struct AgentField: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    func body(content: Content) -> some View {
        content.font(.system(size: 17)).padding(.horizontal, 12).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(WorkspaceStyle.line(scheme)))
    }
}

struct V2AgentItemHistory: View {
    @Bindable var store: V2Store
    let agent: String
    let item: V2LooksAfterItem
    @State private var runsRead = V2Read<[V2AgentRun]>()
    private var runs: [V2AgentRun]? { runsRead.value }
    @State private var error: String?
    @State private var editing = false
    @State private var busy = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    private var savedAgent: V2Agent? { store.snapshot.agents.first { $0.id == agent } }
    private var currentItem: V2LooksAfterItem { savedAgent?.looksAfter?.first { $0.id == item.id } ?? item }
    private var summary: String {
        let item = currentItem
        let computer = store.snapshot.computers.first { $0.id == "coordinator" }?.name ?? "the coordinator"
        let summary = item.summary(projects: store.snapshot.projects).replacingOccurrences(of: " · brings", with: " on \(computer)’s clock · brings")
        let last = runs?.first.map { " Last run \(V2Evidence.elapsed($0.at)) ago." } ?? ""
        return "\(item.what) · \(summary)." + last
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("History").font(.system(size: 28, weight: .semibold))
                Text(summary).font(.system(size: 13)).foregroundStyle(.secondary)
                V2LoadRegion(state: runsRead.state, copy: .resource("Agent runs"), lastHeard: store.readDates["runs:" + agent + ":" + item.id], icons: false, retry: { await loadRuns() }) {
                    V2Group {
                        if let runs {
                            if runs.isEmpty { Text("No runs yet").font(.system(size: 17)).padding(16) }
                            ForEach(runs) { run in
                                Button { store.selectedTaskId = run.id; dismiss() } label: {
                                    V2SettingsRow(list: true, title: V2Evidence.historyDate(run.at, timezone: currentItem.when.timezone), subtitle: "\(run.status) · \(run.title)", icon: nil) { V2SettingsChevron() }
                                }.buttonStyle(.plain)
                            }
                        }
                    }
                }
                Button("Edit item") { editing = true }.font(.system(size: 13)).frame(minHeight: 44)
                if let error { Text(error).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.danger(scheme)) }
                Button("Run now") { runNow() }.buttonStyle(V2PrimaryButtonStyle()).disabled(currentItem.confirmedAt == nil || busy)
            }.padding(20)
        }.background(WorkspaceStyle.canvas(scheme)).navigationBarTitleDisplayMode(.inline).navigationBarBackButtonHidden()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button { dismiss() } label: { Image(systemName: "chevron.left").frame(width: 44, height: 44) }.accessibilityLabel("Back") }
                ToolbarItem(placement: .principal) { if let savedAgent { VStack(spacing: 3) { V2AgentHeader(agent: savedAgent); V2LoadingHeader(states: [runsRead.state]) } } }
            }
            .sheet(isPresented: $editing) { if let savedAgent { V2LooksAfterEditor(store: store, agent: savedAgent, item: currentItem) } }
            .task(id: agent + ":" + item.id) { await loadRuns() }
            .refreshable { await loadRuns() }
            .onDisappear { runsRead.leave() }
    }
    private func loadRuns() async { await runsRead.load(store: store, key: "runs:" + agent + ":" + item.id) { try await store.client.agentItemRuns(agent, item: item.id) } }
    private func runNow() {
        guard !busy else { return }; busy = true
        Task { defer { busy = false }; do { store.selectedTaskId = try await store.client.runAgentItem(agent, item: item.id); dismiss() } catch { self.error = coordinatorErrorDescription(error) } }
    }
}
#endif
