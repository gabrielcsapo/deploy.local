#if os(iOS)
import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import DeployCore

struct V2PickedFile: Codable, Identifiable {
    var id: String
    var name: String
    var bytes: Int
    var url: URL
}
struct V2ComposerSheet: View {
    @Bindable var store: V2Store
    var taskId: String? = nil
    var agent = ""
    var askingAgent = false
    var initialText = ""
    var destinationReady = true
    @State private var mentionClosed = false
    @State private var newAgent = false
    @State private var draft = V2Draft()
    @State private var attachments: [V2PickedFile] = []
    @State private var attachmentMenu = false
    @State private var photos = false
    @State private var photo: PhotosPickerItem?
    @State private var camera = false
    @State private var files = false
    @State private var models = false
    @State private var attachmentError: String?
    @State private var sending = false
    @FocusState private var focused: Bool
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    private var mentionQuery: String? {
        guard !mentionClosed, let range = draft.text.range(of: "@", options: .backwards) else { return nil }
        return String(draft.text[range.upperBound...])
    }
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                if let query = mentionQuery {
                    V2SettingsGroup(title: "Bring an agent into this task", note: "Select a name, then send your message.") {
                        let matches = store.snapshot.agents.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }
                        ForEach(matches) { agent in Button {
                            if let range = draft.text.range(of: "@", options: .backwards) { draft.text = String(draft.text[..<range.lowerBound]) + "@" + agent.name + " " }; mentionClosed = true
                        } label: { V2SettingsRow(title: agent.name, subtitle: agent.lastMessage?.text ?? "Say hello", identity: agent.identity) { if let at = agent.lastMessage?.at { Text(V2Evidence.shortDate(at)).font(.system(size: 13)).foregroundStyle(.secondary) } } }
                        }
                        if matches.isEmpty { if store.snapshot.agents.isEmpty { Button("New agent") { newAgent = true }.font(.system(size: 13)).padding(16) } else { Text("No matching agents").font(.system(size: 13)).padding(16) } }
                    }
                }
                TextField("Ask, build, or follow up…", text: $draft.text, axis: .vertical)
                    .font(.system(size: 17)).lineLimit(4...10).focused($focused).accessibilityIdentifier("v2-composer").onChange(of: draft.text) { old, new in if new.filter({ $0 == "@" }).count > old.filter({ $0 == "@" }).count { mentionClosed = false } }
                if !attachments.isEmpty {
                    ScrollView(.horizontal) {
                        HStack {
                            ForEach(attachments) { file in
                                HStack {
                                    Image(systemName: "doc")
                                    VStack(alignment: .leading) {
                                        Text(file.name).lineLimit(1)
                                        Text(ByteCountFormatter.string(fromByteCount: Int64(file.bytes), countStyle: .file)).foregroundStyle(.secondary)
                                    }
                                    Button { remove(file) } label: { Image(systemName: "xmark.circle.fill").frame(width: 44, height: 44) }.accessibilityLabel("Remove \(file.name)")
                                }.font(.system(size: 13)).padding(.leading, 12).background(WorkspaceStyle.selected(scheme), in: RoundedRectangle(cornerRadius: 8))
                            }
                        }
                    }
                    Text("Files are saved on this iPhone. This coordinator does not support sending attachments yet.").font(.system(size: 13)).foregroundStyle(.secondary)
                }
                if taskId == nil && !askingAgent {
                    HStack {
                        Menu {
                            Button("No project") { draft.projectId = nil }
                            ForEach(store.snapshot.projects) { project in Button(project.name) { draft.projectId = project.id } }
                        } label: { Label(store.snapshot.projects.first { $0.id == draft.projectId }?.name ?? "Project", systemImage: "folder").font(.system(size: 13)) }
                        Menu {
                            ForEach(store.snapshot.workspace?.workers ?? []) { worker in Button(worker.name) { draft.workerId = worker.id } }
                        } label: { Label(store.snapshot.workspace?.workers.first { $0.id == draft.workerId }?.name ?? "Any free computer", systemImage: "desktopcomputer").font(.system(size: 13)) }
                    }.buttonStyle(.bordered)
                    Picker("Request", selection: $draft.question) {
                        Text("Make a change").tag(false)
                        Text("Ask a question").tag(true)
                    }.pickerStyle(.segmented)
                }
                HStack(spacing: 8) {
                    Button { focused = false; attachmentMenu = true } label: { Image(systemName: "plus").frame(width: 44, height: 44) }.accessibilityLabel("Add attachment")
                    Text(taskId == nil ? (draft.question ? (agent.isEmpty ? "Ask a question" : "To \(store.agentName(agent)) · ask a question") : "It will start a task") : "This conversation").font(.system(size: 12)).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    Button { focused = false; models = true } label: { HStack(spacing: 3) { Text(modelName); Image(systemName: "chevron.down").font(.system(size: 8)) }.font(.system(size: 13)).frame(minHeight: 44) }
                    Button { send() } label: { Image(systemName: "arrow.up").font(.system(size: 17, weight: .semibold)) }
                        .buttonStyle(WorkspaceSendStyle()).accessibilityLabel(store.online ? "Send message" : "Queue draft")
                        .disabled(!destinationReady || draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending || !attachments.isEmpty)
                }
                if let error = attachmentError { Text(error).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.danger(scheme)) }
                Spacer(minLength: 0)
            }.padding(16).background(WorkspaceStyle.surface(scheme))
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
                .onAppear {
                    draft = store.composer(taskId: taskId, agent: askingAgent ? agent : nil)
                    draft.taskId = taskId ?? draft.taskId; draft.agent = agent
                    if askingAgent { draft.question = true; if !initialText.isEmpty { draft.text = initialText } }
                    if let worker = store.snapshot.workspace?.workers.first(where: { $0.id == draft.workerId && $0.status == "online" }) ?? store.snapshot.workspace?.workers.first(where: { $0.status == "online" && $0.capabilities.contains(draft.adapter) }) { draft.workerId = worker.id }
                    loadAttachments(); focused = V2Evidence.board == nil
                    switch V2Evidence.board {
                    case "ComposePhone": draft.text = "Make the home-gym sync worker read started_at, and add a test that runs it against the migrated schema"; draft.projectId = "home-gym"
                    case "AttachPhone": focused = false; attachmentMenu = true
                    case "ModelPhone": focused = false; models = true
                    default: break
                    }
                    if V2Evidence.agentsBoard == .mention {
                        draft.text = "@"; mentionClosed = false; focused = false
                    }
                }
                .onChange(of: draft) { _, next in store.saveComposer(next, context: taskId ?? (askingAgent ? "agent:" + agent : "new")) }
                .sheet(isPresented: $newAgent) { V2NewAgentSheet(store: store) { _ in newAgent = false } }
                .sheet(isPresented: $attachmentMenu) { attachmentSheet.presentationDetents([.medium]) }
                .sheet(isPresented: $models) { modelSheet.presentationDetents([.medium, .large]) }
                .photosPicker(isPresented: $photos, selection: $photo, matching: .images)
                .onChange(of: photo) { _, value in Task { await importPhoto(value) } }
                .fileImporter(isPresented: $files, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                    do { for url in try result.get() { try importFile(url) } } catch { attachmentError = error.localizedDescription }
                }
                .fullScreenCover(isPresented: $camera) { V2Camera { image in
                    if let data = image?.jpegData(compressionQuality: 0.85) { do { try save(data, name: "Photo.jpg") } catch { attachmentError = error.localizedDescription } }
                    camera = false
                }.ignoresSafeArea() }
        }.presentationDetents(V2Evidence.agentsBoard == .mention ? [.large] : [.medium, .large]).presentationDragIndicator(.visible)
    }
    private var modelName: String { draft.model ?? "Auto" }
    private var attachmentSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            V2Group {
                Button { attachmentMenu = false; photos = true } label: { V2Row(title: "Photos", subtitle: "Only the photos you pick are shared", icon: "photo") }
                Divider().padding(.leading, 46)
                Button { attachmentMenu = false; camera = true } label: { V2Row(title: "Take a photo", subtitle: "A recipe card, a sketch, a whiteboard", icon: "camera") }.disabled(!UIImagePickerController.isSourceTypeAvailable(.camera) || Bundle.main.object(forInfoDictionaryKey: "NSCameraUsageDescription") == nil)
                Divider().padding(.leading, 46)
                Button { attachmentMenu = false; files = true } label: { V2Row(title: "Files", subtitle: "PDFs, spreadsheets, zips, from Files or iCloud", icon: "doc") }
            }
            Text("deploy.local never reads your photo library. It asks for the camera only the first time you take a photo.").font(.system(size: 13)).foregroundStyle(.secondary)
            Text("App screenshots and project files will be available when this coordinator supports attachments.").font(.system(size: 13)).foregroundStyle(.secondary)
        }.padding(16).presentationDragIndicator(.visible)
    }
    private var modelSheet: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Model for this chat").font(.system(size: 22, weight: .semibold))
                Text("Only changes this chat. Defaults live in Computers › Models.").font(.system(size: 13)).foregroundStyle(.secondary)
                V2Group {
                    Button { draft.model = nil; models = false } label: { V2Row(title: "Auto", subtitle: "Use this computer’s provider default", icon: draft.model == nil ? "largecircle.fill.circle" : "circle") }
                    ForEach(store.snapshot.workspace?.workers.first { $0.id == draft.workerId }?.modelOptions ?? [], id: \.id) { provider in
                        ForEach(provider.models) { model in
                            Divider().padding(.leading, 46)
                            Button { draft.adapter = provider.id; draft.model = model.id; models = false } label: { V2Row(title: model.name, subtitle: provider.id.capitalized, icon: draft.model == model.id ? "largecircle.fill.circle" : "circle") }
                        }
                    }
                }
            }.padding(16)
        }.presentationDragIndicator(.visible)
    }
    private func send() {
        guard destinationReady else { return }
        sending = true
        Task {
            if draft.question, draft.taskId == nil { draft.taskId = store.snapshot.agentTasks[agent] }
            if await store.enqueue(draft) { dismiss() }
            sending = false
        }
    }
    private var attachmentDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("deploy.local/v2-attachments/\(draft.id)")
    }
    private func loadAttachments() {
        if let data = try? Data(contentsOf: attachmentDirectory.appendingPathComponent("index.json")), let files = try? JSONDecoder().decode([V2PickedFile].self, from: data) { attachments = files }
    }
    private func save(_ data: Data, name: String) throws {
        guard data.count <= 20 * 1024 * 1024, attachments.count < 10 else { throw ClientError.response(413, "Choose up to 10 files, each under 20 MB.") }
        let id = UUID().uuidString
        try FileManager.default.createDirectory(at: attachmentDirectory, withIntermediateDirectories: true)
        let url = attachmentDirectory.appendingPathComponent(id)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        attachments.append(V2PickedFile(id: id, name: name, bytes: data.count, url: url))
        try JSONEncoder().encode(attachments).write(to: attachmentDirectory.appendingPathComponent("index.json"), options: [.atomic, .completeFileProtection])
    }
    private func remove(_ file: V2PickedFile) {
        attachments.removeAll { $0.id == file.id }
        try? FileManager.default.removeItem(at: file.url)
        try? JSONEncoder().encode(attachments).write(to: attachmentDirectory.appendingPathComponent("index.json"), options: [.atomic, .completeFileProtection])
    }
    private func importFile(_ url: URL) throws {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= 20 * 1024 * 1024 else { throw ClientError.response(413, "Choose a file under 20 MB.") }
        try save(Data(contentsOf: url), name: url.lastPathComponent)
    }
    private func importPhoto(_ item: PhotosPickerItem?) async {
        do { if let data = try await item?.loadTransferable(type: Data.self) { try save(data, name: "Photo.\(item?.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg")") } }
        catch { attachmentError = error.localizedDescription }
    }
}
/// Task messages stay in the conversation; @ opens the picker directly above this field.
struct V2TaskComposer: View {
    @Bindable var store: V2Store
    let taskId: String
    let expand: () -> Void
    var destinationReady = true
    @State private var draft = V2Draft()
    @State private var mentionClosed = false
    @State private var sending = false
    @State private var newAgent = false
    @Environment(\.colorScheme) private var scheme
    private var query: String? {
        guard !mentionClosed, let range = draft.text.range(of: "@", options: .backwards) else { return nil }
        let query = String(draft.text[range.upperBound...])
        return query.contains("\n") ? nil : query
    }
    var body: some View {
        VStack(spacing: 8) {
            if let query {
                VStack(alignment: .leading, spacing: 0) {
                    Text("Bring an agent into this task").font(.system(size: 13)).foregroundStyle(.secondary).padding(12)
                    let matches = store.snapshot.agents.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }
                    ForEach(matches) { agent in
                        Button { select(agent) } label: {
                            HStack(spacing: 12) {
                                AgentAvatar(glyph: agent.identity.glyph, color: agent.identity.color, size: 32)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(agent.name).font(.system(size: 17))
                                    Text(agent.lastMessage?.text ?? "Say hello").font(.system(size: 13)).foregroundStyle(.secondary).lineLimit(1)
                                }
                                Spacer(minLength: 0)
                                if let at = agent.lastMessage?.at { Text(V2Evidence.shortDate(at)).font(.system(size: 13)).foregroundStyle(.secondary) }
                            }.padding(.horizontal, 12).frame(minHeight: 52).contentShape(Rectangle())
                        }.buttonStyle(.plain)
                    }
                    if matches.isEmpty {
                        if store.snapshot.agents.isEmpty { Button("New agent") { newAgent = true }.padding(12) }
                        else { Text("No matching agents").font(.system(size: 13)).padding(12) }
                    }
                    Text("Select a name, then send your message.").font(.system(size: 13)).foregroundStyle(.secondary).padding(12)
                }.background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(WorkspaceStyle.line(scheme)))
            }
            HStack(spacing: 8) {
                Button(action: expand) { Image(systemName: "plus").frame(width: 32, height: 44) }.accessibilityLabel("Attachments and message options")
                TextField("Ask, build, or follow up…", text: $draft.text, axis: .vertical)
                    .font(.system(size: 17)).lineLimit(1...5).accessibilityIdentifier("v2-composer")
                    .onChange(of: draft.text) { old, new in
                        if new.filter({ $0 == "@" }).count > old.filter({ $0 == "@" }).count { mentionClosed = false }
                    }
                Button(action: expand) { HStack(spacing: 2) { Text(draft.model ?? "Auto"); Image(systemName: "chevron.down").font(.system(size: 8)) }.font(.system(size: 13)).foregroundStyle(.secondary) }
                Button { send() } label: { Image(systemName: "arrow.up").font(.system(size: 17, weight: .semibold)) }
                    .buttonStyle(WorkspaceSendStyle()).accessibilityLabel("Send message")
                    .disabled(!destinationReady || draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
            }.padding(.horizontal, 10).padding(.vertical, 4)
                .background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: 24))
                .overlay(RoundedRectangle(cornerRadius: 24).stroke(WorkspaceStyle.line(scheme)))
        }.padding(12)
            .onAppear {
                draft = store.composer(taskId: taskId); draft.taskId = taskId
                if V2Evidence.agentsBoard == .mention { draft.text = "@" }
            }
            .onChange(of: draft) { _, next in store.saveComposer(next, context: taskId) }
            .sheet(isPresented: $newAgent) { V2NewAgentSheet(store: store) { _ in newAgent = false } }
    }
    private func select(_ agent: V2Agent) {
        guard let range = draft.text.range(of: "@", options: .backwards) else { return }
        draft.text = String(draft.text[..<range.lowerBound]) + "@" + agent.name + " "
        mentionClosed = true
    }
    private func send() {
        guard destinationReady else { return }
        sending = true
        Task {
            if await store.enqueue(draft) { draft = store.composer(taskId: taskId); draft.taskId = taskId; mentionClosed = false }
            sending = false
        }
    }
}

private struct V2Camera: UIViewControllerRepresentable {
    let completion: (UIImage?) -> Void
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController(); picker.sourceType = .camera; picker.delegate = context.coordinator; return picker
    }
    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(completion: completion) }
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let completion: (UIImage?) -> Void
        init(completion: @escaping (UIImage?) -> Void) { self.completion = completion }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) { completion(info[.originalImage] as? UIImage) }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { completion(nil) }
    }
}
#endif
