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
    @State private var attachmentTaskId: String?
    @State private var creatingAttachmentTask = false
    @FocusState private var focused: Bool
    @Environment(\.colorScheme) private var colorScheme

    private var worker: Worker? { store.state?.workers.first { $0.id == workerId } }
    private var canRun: Bool { worker?.isProviderAvailable(store.adapter) ?? false }
    private func selectComputer() {
        if let selected = preferredTaskWorkerId(workers: store.state?.workers ?? [], current: workerId) { workerId = selected }
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: WorkspaceStyle.space4) {
                WorkspaceGlyph(name: .brand).foregroundStyle(WorkspaceStyle.secondaryText(colorScheme))
                if let project = store.projects.first(where: { $0.id == projectId }) {
                    // One line when it fits (Mac, iPad); otherwise the project name moves to its own
                    // centred line instead of wrapping beside the question on a different baseline.
                    let name = HStack(alignment: .firstTextBaseline, spacing: 0) {
                        Menu { projectPicker } label: { Text(project.name) }
                            .modifier(WorkspaceMenuStyle()).fixedSize()
                        Text("?")
                    }
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .firstTextBaseline, spacing: 0) { Text("What should we build in ").fixedSize(); name }
                        VStack(spacing: 2) { Text("What should we build in"); name }
                    }.font(WorkspaceStyle.display).multilineTextAlignment(.center)
                } else {
                    Text("What should we build?").font(WorkspaceStyle.display).multilineTextAlignment(.center)
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            VStack(spacing: 0) {
                WorkspaceContextTray {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: WorkspaceStyle.space4) { contextControls }
                        VStack(alignment: .leading, spacing: WorkspaceStyle.space2) { contextControls }
                    }
                }
                VStack(alignment: .leading, spacing: WorkspaceStyle.space2) {
                    if let notice = worker?.busyNotice { Text(notice).font(.caption).foregroundStyle(.secondary) }
                    TextField("Message", text: $draft, prompt: Text("Ask, build, or follow up…").foregroundColor(WorkspaceStyle.secondaryText(colorScheme)), axis: .vertical)
                        .textFieldStyle(.plain).font(WorkspaceStyle.body).lineLimit(1...6).autocorrectionDisabled().frame(minHeight: 24, alignment: .top)
                        .focused($focused).accessibilityIdentifier("new-task-prompt")
                    HStack(spacing: 10) {
                        AttachmentComposerControl(store: store, add: attachToTask, addFile: attachFileToTask)
                        VoiceInput(connection: store.connection, draft: $draft)
                        Spacer(minLength: 4)
                        AgentControls(store: store, workerId: workerId, disabled: store.busy, resetsOnComputerChange: true)
                        if store.busy { ProgressView().controlSize(.small) }
                        Button { createAndSend() } label: {
                            Image(systemName: "arrow.up").font(.system(.subheadline, weight: .bold)).frame(width: 24, height: 24)
                        }.buttonStyle(WorkspaceSendStyle())
                            .keyboardShortcut(.return, modifiers: .command).accessibilityLabel("Start task")
                            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.busy || !store.isConnected || !canRun)
                    }.controlSize(.small)
                }.padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 8)
            }.modifier(WorkspacePromptSurface()).modifier(AttachmentComposerInput(store: store, add: attachToTask, addFile: attachFileToTask))
            if store.isConnected && !canRun {
                Text(worker == nil ? "No task computer is connected. Manage workers and providers in deploy.local Settings." : "This provider is unavailable on \(worker!.name). Manage its connection in deploy.local Settings.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            if let error = store.error {
                Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled)
            }
        }.padding(.horizontal, WorkspaceStyle.conversationGutter).frame(maxWidth: WorkspaceStyle.contentWidth).padding(.bottom, 8).padding(.top, 6).frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(WorkspaceStyle.canvas(colorScheme))
            .onAppear { projectId = initialProjectId; selectComputer(); focused = true }
            .onChange(of: store.state?.workers) { _, _ in selectComputer() }
    }

    private var projectPicker: some View {
            Picker("Project", selection: $projectId) {
                Text("No project").tag("")
                ForEach(store.projects) { project in Text(project.name).tag(project.id) }
            }
    }

    @ViewBuilder private var contextControls: some View {
        Menu {
            projectPicker
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
        WorkerUpdateWarning(update: worker?.update)
    }

    private func attachFileToTask(_ file: URL) async {
        guard await prepareAttachmentTask() else { return }
        await store.addAttachment(file: file)
    }
    private func attachToTask(_ data: Data, _ name: String) async {
        guard await prepareAttachmentTask() else { return }
        await store.addAttachment(data: data, name: name)
    }
    private func prepareAttachmentTask() async -> Bool {
        while creatingAttachmentTask { do { try await Task.sleep(for: .milliseconds(100)) } catch { return false } }
        if attachmentTaskId == nil {
            guard !store.busy, store.isConnected else { return false }
            creatingAttachmentTask = true
            defer { creatingAttachmentTask = false }
            let content = draft
            guard await store.createTask(projectId: projectId.isEmpty ? nil : projectId, title: taskTitle(content.isEmpty ? "Media" : content), workerId: workerId) else { return false }
            attachmentTaskId = store.selectedTaskId
            store.draft = content; store.saveDraft(); draft = ""; onCreated()
        }
        return store.selectedTaskId == attachmentTaskId
    }

    private func createAndSend() {
        let content = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty, !store.busy, store.isConnected, canRun else { return }
        let title = taskTitle(content)
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
