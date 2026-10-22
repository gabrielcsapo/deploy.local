import SwiftUI
import DeployCore

/// Repository content occupies the workspace; branch and path controls stay in one toolbar.
@MainActor
struct RepositoryBrowserView: View {
    let projectId: String
    let connection: Connection
    let repository: RepositoryInfo?
    let retrySetup: () -> Void
    var tasks: [WorkspaceTask]
    var initialTaskId: String?
    var initialPath: String
    var startTask: (String, String) -> Void
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    @Environment(\.colorScheme) private var colorScheme
    @SceneStorage private var branch: String
    @SceneStorage private var folder: String
    @SceneStorage private var selectedFilePath: String
    @State private var listing: BrowserTree?
    @State private var file: BrowserFile?
    @State private var loading = false
    @State private var error: String?
    @State private var refreshID = 0
    @State private var openingPath: String?
    @State private var fileTask: Task<Void, Never>?
    @State private var fileRequestID = UUID()
    private var branches: [String] {
        (repository?.refs ?? []).filter { $0.name.hasPrefix("refs/heads/") }
            .map { String($0.name.dropFirst(11)) }.sorted()
    }
    private var taskId: String? { branch.hasPrefix("task:") ? String(branch.dropFirst(5)) : nil }
    private var sourceTitle: String { tasks.first { $0.id == taskId }.map { "Task: \($0.title) · \($0.status)" } ?? selectedBranch }
    private var available: Bool { taskId != nil || repository?.status == "ready" }
    private var selectedBranch: String { branch.isEmpty ? repository?.defaultBranch ?? "main" : branch }
    private var requestID: String { "\(repository?.status ?? "")|\(selectedBranch)|\(folder)|\(refreshID)" }
    private var base: String { taskId.map { "/api/workspace/tasks/\($0)/files" } ?? "/api/workspace/projects/\(projectId)/repository" }
    private func endpoint(_ file: Bool, path: String, ref: String) -> String {
        base + (taskId == nil ? (file ? "/blob" : "/tree") : (file ? "/content" : "")) + "?ref=\(encoded(ref))&path=\(encoded(path))"
    }
    private func encoded(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "" }

    init(projectId: String, connection: Connection, repository: RepositoryInfo?, tasks: [WorkspaceTask] = [], initialTaskId: String? = nil, initialPath: String = "", startTask: @escaping (String, String) -> Void = { _, _ in }, retrySetup: @escaping () -> Void) {
        self.projectId = projectId; self.connection = connection
        self.repository = repository; self.retrySetup = retrySetup
        self.tasks = tasks; self.initialTaskId = initialTaskId; self.initialPath = initialPath; self.startTask = startTask
        let key = "repository.\(connection.origin).\(connection.username).\(projectId)"
        _branch = SceneStorage(wrappedValue: initialTaskId.map { "task:\($0)" } ?? "", key + ".branch")
        _folder = SceneStorage(wrappedValue: "", key + ".folder")
        _selectedFilePath = SceneStorage(wrappedValue: initialPath, key + ".file")
    }

    var body: some View {
        Group {
            #if os(iOS)
            if horizontalSizeClass == .compact {
                phoneRepository
            } else { browserContent }
            #else
            browserContent
            #endif
        }.onAppear {
            if let initialTaskId { branch = "task:\(initialTaskId)"; folder = initialPath.split(separator: "/").dropLast().joined(separator: "/"); selectedFilePath = initialPath }
        }
    }

    private var browserContent: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                sourcePicker
                Spacer(minLength: 8)
                if let commit = listing?.commit {
                    Text(String(commit.prefix(7))).font(.caption.monospaced()).foregroundStyle(.secondary)
                        .help(commit).textSelection(.enabled)
                }
                WorkspaceIconButton(label: "Refresh repository", icon: .refresh) { fileTask?.cancel(); file = nil; refreshID += 1 }.disabled(loading)
            }.padding(.horizontal, 20).padding(.vertical, 14)
            if let error {
                HStack(alignment: .top, spacing: 10) {
                    WorkspaceGlyph(name: .alert, size: 18)
                    Text(error).textSelection(.enabled)
                    Spacer(minLength: 0)
                    WorkspaceIconButton(label: "Retry repository", icon: .refresh) { refreshID += 1 }
                }.font(.callout).foregroundStyle(.secondary).padding(16)
            }
            if !available {
                VStack(alignment: .leading, spacing: 12) {
                    Text(repository?.status == nil ? "Loading repository…" : "Repository \(repository!.status)")
                        .font(.headline)
                    if let failure = repository?.operation?.error { Text(failure).foregroundStyle(.secondary) }
                    if ["failed", "unknown", "cancelled"].contains(repository?.operation?.status ?? "") {
                        Button("Retry setup", action: retrySetup).buttonStyle(.workspaceLink)
                    }
                }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                pathBar
                if let file { sourceView(file) }
                else if loading && listing == nil {
                    WorkspaceSkeleton(label: "Loading files").frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let listing, listing.entries.isEmpty {
                    Text(listing.omitted ?? "This folder is empty.").foregroundStyle(.secondary)
                        .padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                } else { fileList }
            }
        }
        .background(WorkspaceStyle.canvas(colorScheme))
        .tint(WorkspaceStyle.accent(colorScheme))
        .task(id: requestID) { await load() }
        .onChange(of: branch) { _, value in
            resetFile(); folder = ""; listing = nil
            if value == initialTaskId.map({ "task:\($0)" }) { folder = initialPath.split(separator: "/").dropLast().joined(separator: "/"); selectedFilePath = initialPath }
        }
        .onDisappear { fileTask?.cancel(); fileRequestID = UUID(); openingPath = nil }
    }

    #if os(iOS)
    private var phoneRepository: some View {
        VStack(spacing: 0) {
            sourcePicker.padding().frame(maxWidth: .infinity, alignment: .leading)
            if available {
                if !initialPath.isEmpty && taskId == initialTaskId {
                    PhoneRepositoryFile(projectId: projectId, connection: connection, ref: selectedBranch, path: initialPath, taskId: taskId, startTask: startTask)
                        .id(selectedBranch + initialPath)
                } else {
                    PhoneRepositoryFolder(projectId: projectId, connection: connection, ref: selectedBranch, path: "", taskId: taskId, startTask: startTask)
                        .id(selectedBranch)
                }
            } else if repository == nil { WorkspaceSkeleton(label: "Loading repository").frame(maxWidth: .infinity, maxHeight: .infinity) }
            else {
                ContentUnavailableView {
                    Label("Repository \(repository?.status ?? "unavailable")", systemImage: "folder")
                } description: { Text(repository?.operation?.error ?? "Repository setup has not finished.") }
                actions: {
                    if ["failed", "unknown", "cancelled"].contains(repository?.operation?.status ?? "") {
                        Button("Retry setup", action: retrySetup).buttonStyle(.workspaceLink)
                    } else { ProgressView("Setting up repository…") }
                }
            }
        }.background(WorkspaceStyle.canvas(colorScheme))
    }
    #endif

    private var sourcePicker: some View {
        Menu {
            Section("Branches") {
                ForEach(branches, id: \.self) { value in Button(value) { branch = value } }
            }
            Section("Task") {
                ForEach(tasks.filter { !$0.workspacePath.isEmpty }) { task in
                    Button("\(task.title) · \(task.status)") { branch = "task:\(task.id)" }
                }
            }
        } label: { WorkspaceMenuLabel(title: sourceTitle, symbol: "arrow.triangle.branch") }
            .modifier(WorkspaceMenuStyle()).accessibilityLabel("Repository source: \(sourceTitle)")
    }

    private var pathBar: some View {
        HStack(spacing: 10) {
            if file != nil || !folder.isEmpty {
                WorkspaceIconButton(label: file == nil ? "Up one folder" : "Back to files", icon: .back) {
                    let wasShowingFile = file != nil
                    resetFile()
                    if !wasShowingFile { folder = folder.split(separator: "/").dropLast().joined(separator: "/"); listing = nil }
                }
            }
            Text((file?.path ?? (folder.isEmpty ? "/" : folder)) + (file?.change.map { " · \($0)" } ?? ""))
                .font(.callout.monospaced()).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
            Spacer(minLength: 0)
            if let file {
                Button("New task") { startTask(selectedBranch, file.path) }.buttonStyle(.workspaceLink)
            }
            if file == nil, let listing {
                Text("\(listing.entries.count) items").font(.caption).foregroundStyle(.secondary)
            }
            if openingPath != nil { ProgressView().controlSize(.small) }
        }.padding(.horizontal, 20).padding(.vertical, 12)
            .background(Color.primary.opacity(0.025))
    }

    private var fileList: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Name"); Spacer(); Text("Kind").frame(width: 76, alignment: .leading)
            }.font(.caption).foregroundStyle(.secondary).padding(.horizontal, 20).padding(.vertical, 10)
            List {
                ForEach(listing?.entries ?? []) { entry in
                    Button { open(entry) } label: {
                        HStack(spacing: 12) {
                            WorkspaceGlyph(name: entry.type == "tree" ? .folder : .file, size: 18)
                                .foregroundStyle(entry.type == "tree" ? WorkspaceStyle.accent(colorScheme) : .secondary)
                                .frame(width: 18)
                            Text(entry.name + (entry.change.map { " · \($0)" } ?? "")).lineLimit(1).truncationMode(.middle).foregroundStyle(.primary)
                            Spacer(minLength: 8)
                            Text(entry.type == "tree" ? "Folder" : entry.type == "blob" ? "File" : "Submodule")
                                .font(.caption).foregroundStyle(.secondary).frame(width: 76, alignment: .leading)
                        }.padding(.vertical, 9).contentShape(Rectangle())
                    }.buttonStyle(.plain).disabled(!["tree", "blob"].contains(entry.type) || openingPath != nil)
                        .listRowSeparator(.hidden)
                        .accessibilityLabel("\(entry.name), \(entry.type == "tree" ? "folder" : "file")\(entry.change.map { ", \($0)" } ?? "")")
                }
            }.listStyle(.plain).scrollContentBackground(.hidden)
        }
    }

    private func sourceView(_ file: BrowserFile) -> some View {
        Group {
            if let content = file.content { RepositorySourceView(content: content, path: file.path) }
            else { Text(file.omitted ?? "Empty file").foregroundStyle(.secondary).padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading) }
        }.id(file.path)
    }

    private func load() async {
        guard available else { return }
        let expected = requestID
        loading = true; error = nil
        defer { if requestID == expected { loading = false } }
        do {
            let next: BrowserTree = try await WorkspaceClient(connection: connection).request(endpoint(false, path: folder, ref: selectedBranch))
            guard !Task.isCancelled, requestID == expected else { return }
            listing = next
            if !selectedFilePath.isEmpty { openFile(path: selectedFilePath, commit: next.commit ?? selectedBranch) }
        } catch { if !Task.isCancelled, requestID == expected { self.error = error.localizedDescription } }
    }

    private func open(_ entry: BrowserTree.Entry) {
        if entry.type == "tree" { resetFile(); folder = entry.path; listing = nil; return }
        let commit = listing?.commit ?? selectedBranch
        openFile(path: entry.path, commit: commit)
    }

    private func resetFile() {
        fileTask?.cancel(); fileRequestID = UUID()
        file = nil; selectedFilePath = ""; openingPath = nil
    }

    private func openFile(path: String, commit: String) {
        fileTask?.cancel()
        let token = UUID(); fileRequestID = token
        let expectedBranch = selectedBranch, expectedFolder = folder
        openingPath = path; error = nil
        fileTask = Task {
            do {
                let next: BrowserFile = try await WorkspaceClient(connection: connection).request(endpoint(true, path: path, ref: commit))
                guard !Task.isCancelled, fileRequestID == token, selectedBranch == expectedBranch, folder == expectedFolder else { return }
                file = next; selectedFilePath = path; openingPath = nil
            } catch { if !Task.isCancelled, fileRequestID == token { self.error = error.localizedDescription; openingPath = nil } }
        }
    }
}

private struct BrowserTree: Decodable {
    let commit: String?
    let omitted: String?
    let entries: [Entry]
    struct Entry: Decodable, Identifiable { var id: String { path }; let name: String; let path: String; let type: String; let change: String? }
}
private struct BrowserFile: Decodable { let path: String; let content: String?; let omitted: String?; let change: String? }

#if os(iOS)
/// Each folder and file is a destination in the tab's stack, preserving system swipe-back.
private struct PhoneRepositoryFolder: View {
    let projectId: String
    let connection: Connection
    let ref: String
    let path: String
    var taskId: String? = nil
    var startTask: (String, String) -> Void = { _, _ in }
    @State private var tree: BrowserTree?
    @State private var error: String?
    @State private var refreshID = 0
    var body: some View {
        List {
            ForEach(tree?.entries ?? []) { entry in
                if entry.type == "tree" || entry.type == "blob" {
                    NavigationLink {
                        if entry.type == "tree" {
                            PhoneRepositoryFolder(projectId: projectId, connection: connection, ref: tree?.commit ?? ref, path: entry.path, taskId: taskId, startTask: startTask)
                                .navigationTitle(entry.name).navigationBarTitleDisplayMode(.inline)
                        } else {
                            PhoneRepositoryFile(projectId: projectId, connection: connection, ref: tree?.commit ?? ref, path: entry.path, taskId: taskId, startTask: startTask)
                                .navigationTitle(entry.name).navigationBarTitleDisplayMode(.inline)
                        }
                    } label: {
                        Label { Text(entry.name + (entry.change.map { " · \($0)" } ?? "")).lineLimit(2) } icon: { WorkspaceGlyph(name: entry.type == "tree" ? .folder : .file) }
                            .frame(minHeight: 44)
                    }.accessibilityLabel("\(entry.name), \(entry.type == "tree" ? "folder" : "file")\(entry.change.map { ", \($0)" } ?? "")")
                } else { Text(entry.name + (entry.change.map { " · \($0)" } ?? "")).lineLimit(2) }
            }
        }.listStyle(.plain)
            .overlay {
                if let error {
                    ContentUnavailableView {
                        Label("Couldn’t load files", systemImage: "exclamationmark.triangle")
                    } description: { Text(error) } actions: { WorkspaceIconButton(label: "Retry repository", icon: .refresh) { refreshID += 1 } }
                } else if tree == nil { WorkspaceSkeleton(label: "Loading files") }
                else if tree?.entries.isEmpty == true { ContentUnavailableView("No files", systemImage: "folder", description: Text(tree?.omitted ?? "This folder is empty.")) }
            }
            .refreshable { await load() }
            .task(id: refreshID) { await load() }
    }
    private func load() async {
        do {
            error = nil
            let encodedRef = ref.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
            let encodedPath = path.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
            let next: BrowserTree = try await WorkspaceClient(connection: connection).request((taskId.map { "/api/workspace/tasks/\($0)/files" } ?? "/api/workspace/projects/\(projectId)/repository/tree") + "?ref=\(encodedRef)&path=\(encodedPath)")
            if !Task.isCancelled { tree = next }
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

private struct PhoneRepositoryFile: View {
    let projectId: String
    let connection: Connection
    let ref: String
    let path: String
    var taskId: String? = nil
    var startTask: (String, String) -> Void = { _, _ in }
    @State private var file: BrowserFile?
    @State private var error: String?
    @State private var refreshID = 0
    var body: some View {
        Group {
            if let file {
                VStack(spacing: 0) {
                    HStack {
                        Text(path + (file.change.map { " · \($0)" } ?? "")).font(WorkspaceStyle.metadata).lineLimit(2).truncationMode(.middle)
                        Spacer()
                        WorkspaceIconButton(label: "Refresh files", icon: .refresh) { self.file = nil; refreshID += 1 }
                        Button("New task") { startTask(ref, path) }.buttonStyle(.workspaceLink)
                    }.padding(16)
                    if let content = file.content { RepositorySourceView(content: content, path: path) }
                    else { Text(file.omitted ?? "Empty file").foregroundStyle(.secondary).padding(16).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading) }
                }

            } else if let error {
                ContentUnavailableView {
                    Label("Couldn’t load file", systemImage: "exclamationmark.triangle")
                } description: { Text(error) } actions: { WorkspaceIconButton(label: "Retry repository", icon: .refresh) { refreshID += 1 } }
            } else { ProgressView("Loading file…") }
        }.task(id: refreshID) {
            do {
                error = nil
                let encodedRef = ref.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
                let encodedPath = path.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
                let next: BrowserFile = try await WorkspaceClient(connection: connection).request((taskId.map { "/api/workspace/tasks/\($0)/files/content" } ?? "/api/workspace/projects/\(projectId)/repository/blob") + "?ref=\(encodedRef)&path=\(encodedPath)")
                if !Task.isCancelled { file = next }
            } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
    }
}
#endif
