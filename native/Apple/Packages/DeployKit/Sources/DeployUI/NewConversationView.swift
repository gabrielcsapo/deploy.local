import SwiftUI
import DeployCore

/// Start anywhere; a repository is context the user can choose, not a prerequisite.
struct NewConversationView: View {
    @Bindable var store: WorkspaceStore
    @Binding var draft: String
    @Binding var workerId: String
    let initialProjectId: String
    let onCreated: () -> Void
    @State private var projectId = ""
    @FocusState private var focused: Bool

    private var worker: Worker? { store.state?.workers.first { $0.id == workerId } }
    private var canRun: Bool { worker?.isProviderAvailable(store.adapter) ?? false }
    private func selectComputer() {
        if let selected = preferredTaskWorkerId(workers: store.state?.workers ?? [], current: workerId) { workerId = selected }
    }

    var body: some View {
        VStack(spacing: 20) {
            Spacer(minLength: 16)
            VStack(spacing: 9) {
                Text("What would you like to do?")
                    .font(.system(.title, design: .default).weight(.medium)).tracking(-0.6).multilineTextAlignment(.center)
                Text(projectId.isEmpty ? "Start a task, or choose a project to work in." : store.projects.first { $0.id == projectId }?.name ?? "")
                    .font(.callout).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 16) {
                TextField("Message", text: $draft, prompt: Text("Ask deploy.local…").foregroundColor(.primary.opacity(0.6)), axis: .vertical)
                    .textFieldStyle(.plain).font(WorkspaceStyle.body).lineLimit(2...8).autocorrectionDisabled()
                    .focused($focused).accessibilityIdentifier("new-task-prompt")
                HStack(spacing: 10) {
                    VoiceInput(connection: store.connection, draft: $draft)
                    Spacer(minLength: 4)
                    AgentControls(store: store, workerId: workerId, disabled: store.busy)
                    if store.busy { ProgressView().controlSize(.small) }
                    Button { createAndSend() } label: {
                        Image(systemName: "arrow.up").font(.system(size: 14, weight: .bold)).frame(width: 26, height: 26)
                    }.buttonStyle(WorkspaceSendStyle())
                        .keyboardShortcut(.return, modifiers: .command).accessibilityLabel("Start task")
                        .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.busy || !store.isConnected || !canRun)
                }.controlSize(.small)
            }.padding(16).modifier(WorkspaceSurface(radius: 28))
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 20) { contextControls }
                VStack(spacing: 12) { contextControls }
            }.font(WorkspaceStyle.navigation).foregroundStyle(.secondary)
            if store.isConnected && !canRun {
                Text(worker == nil ? "No task computer is connected. Manage workers and providers in deploy.local Settings." : "This provider is unavailable on \(worker!.name). Manage its connection in deploy.local Settings.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            if let error = store.error {
                Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled)
            }
            Spacer(minLength: 24)
        }.frame(maxWidth: WorkspaceStyle.contentWidth).padding(.horizontal, 24).frame(maxWidth: .infinity, maxHeight: .infinity)
            .onAppear { projectId = initialProjectId; selectComputer(); focused = true }
            .onChange(of: store.state?.workers) { _, _ in selectComputer() }
    }

    @ViewBuilder private var contextControls: some View {
        Menu {
            Picker("Project", selection: $projectId) {
                Text("No project").tag("")
                ForEach(store.projects) { project in Text(project.name).tag(project.id) }
            }
        } label: {
            WorkspaceMenuLabel(title: store.projects.first { $0.id == projectId }?.name ?? "No project", symbol: "folder")
        }.modifier(WorkspaceMenuStyle()).frame(maxWidth: 260).fixedSize(horizontal: true, vertical: false).accessibilityLabel("Project")
        Menu {
            Picker("Computer", selection: $workerId) {
                ForEach(store.state?.workers ?? []) { worker in Text(worker.id == "local" ? "Local" : worker.name).tag(worker.id) }
            }
        } label: {
            WorkspaceMenuLabel(title: workerId == "local" ? "Local" : store.state?.workers.first { $0.id == workerId }?.name ?? "Computer", symbol: "desktopcomputer")
        }.modifier(WorkspaceMenuStyle()).frame(maxWidth: 260).fixedSize(horizontal: true, vertical: false).accessibilityLabel("Computer")
    }

    private func createAndSend() {
        let content = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty, !store.busy, store.isConnected, canRun else { return }
        let title = String((content.components(separatedBy: "\n").first ?? content).prefix(70))
        Task {
            if await store.createTask(projectId: projectId.isEmpty ? nil : projectId, title: title, workerId: workerId) {
                store.draft = content
                store.saveDraft()
                draft = ""
                onCreated()
                await store.send()
            }
        }
    }
}
