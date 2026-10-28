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
    var agent = "scout"
    var askingAgent = false
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
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                TextField("Ask, build, or follow up…", text: $draft.text, axis: .vertical)
                    .font(.system(size: 17)).lineLimit(4...10).focused($focused).accessibilityIdentifier("v2-composer")
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
                if taskId == nil {
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
                    Text(taskId == nil ? (draft.question ? "To \(agent.capitalized) · ask a question" : "To Scout · it will start a task") : "This conversation").font(.system(size: 12)).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    Button { focused = false; models = true } label: { HStack(spacing: 3) { Text(modelName); Image(systemName: "chevron.down").font(.system(size: 8)) }.font(.system(size: 13)).frame(minHeight: 44) }
                    Button { send() } label: { Image(systemName: "arrow.up").font(.system(size: 17, weight: .semibold)) }
                        .buttonStyle(WorkspaceSendStyle()).accessibilityLabel(store.online ? "Send message" : "Queue draft")
                        .disabled(draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending || !attachments.isEmpty)
                }
                if let error = attachmentError { Text(error).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.danger(scheme)) }
                Spacer(minLength: 0)
            }.padding(16).background(WorkspaceStyle.surface(scheme))
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
                .onAppear {
                    draft = store.composer(taskId: taskId, agent: askingAgent ? agent : nil)
                    draft.taskId = taskId ?? draft.taskId; draft.agent = agent
                    if askingAgent { draft.question = true }
                    if let worker = store.snapshot.workspace?.workers.first(where: { $0.id == draft.workerId && $0.status == "online" }) ?? store.snapshot.workspace?.workers.first(where: { $0.status == "online" && $0.capabilities.contains(draft.adapter) }) { draft.workerId = worker.id }
                    loadAttachments(); focused = true
                    switch V2Evidence.board {
                    case "ComposePhone": draft.text = "Make the home-gym sync worker read started_at, and add a test that runs it against the migrated schema"; draft.projectId = "home-gym"
                    case "AttachPhone": focused = false; attachmentMenu = true
                    case "ModelPhone": focused = false; models = true
                    default: break
                    }
                }
                .onChange(of: draft) { _, next in store.saveComposer(next) }
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
        }.presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
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
