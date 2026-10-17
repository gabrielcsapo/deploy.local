import SwiftUI
import DeployCore

/// Repository content occupies the workspace; branch and path controls stay in one toolbar.
@MainActor
struct RepositoryBrowserView: View {
    let projectId: String
    let connection: Connection
    let repository: RepositoryInfo?
    let retrySetup: () -> Void
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
    private var selectedBranch: String { branch.isEmpty ? repository?.defaultBranch ?? "main" : branch }
    private var requestID: String { "\(repository?.status ?? "")|\(selectedBranch)|\(folder)|\(refreshID)" }
    private var base: String { "/api/workspace/projects/\(projectId)/repository" }

    init(projectId: String, connection: Connection, repository: RepositoryInfo?, retrySetup: @escaping () -> Void) {
        self.projectId = projectId; self.connection = connection
        self.repository = repository; self.retrySetup = retrySetup
        let key = "repository.\(connection.origin).\(connection.username).\(projectId)"
        _branch = SceneStorage(wrappedValue: "", key + ".branch")
        _folder = SceneStorage(wrappedValue: "", key + ".folder")
        _selectedFilePath = SceneStorage(wrappedValue: "", key + ".file")
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Menu {
                    ForEach(branches, id: \.self) { value in
                        Button { branch = value } label: {
                            if value == selectedBranch { Label(value, systemImage: "checkmark") }
                            else { Text(value) }
                        }
                    }
                } label: { WorkspaceMenuLabel(title: selectedBranch, symbol: "arrow.triangle.branch") }
                    .modifier(WorkspaceMenuStyle()).disabled(branches.isEmpty)
                    .accessibilityLabel("Repository branch: \(selectedBranch)")
                Spacer(minLength: 8)
                if let commit = listing?.commit {
                    Text(String(commit.prefix(7))).font(.caption.monospaced()).foregroundStyle(.secondary)
                        .help(commit).textSelection(.enabled)
                }
                Button { resetFile(); refreshID += 1 } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.plain).disabled(loading).accessibilityLabel("Refresh repository")
            }.padding(.horizontal, 20).padding(.vertical, 14)
            if let error {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "exclamationmark.circle")
                    Text(error).textSelection(.enabled)
                    Spacer(minLength: 0)
                    Button("Retry") { refreshID += 1 }
                }.font(.callout).foregroundStyle(.secondary).padding(16)
            }
            if repository?.status != "ready" {
                VStack(alignment: .leading, spacing: 12) {
                    Text(repository?.status == nil ? "Loading repository…" : "Repository \(repository!.status)")
                        .font(.headline)
                    if let failure = repository?.operation?.error { Text(failure).foregroundStyle(.secondary) }
                    if ["failed", "unknown", "cancelled"].contains(repository?.operation?.status ?? "") {
                        Button("Retry setup", action: retrySetup)
                    }
                }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                pathBar
                if let file { sourceView(file) }
                else if loading && listing == nil {
                    ProgressView("Loading files…").frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let listing, listing.entries.isEmpty {
                    Text("No files on this branch.").foregroundStyle(.secondary)
                        .padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                } else { fileList }
            }
        }
        .background(WorkspaceStyle.canvas(colorScheme))
        .tint(WorkspaceStyle.accent(colorScheme))
        .task(id: requestID) { await load() }
        .onChange(of: branch) { _, _ in resetFile(); folder = ""; listing = nil }
        .onDisappear { fileTask?.cancel(); fileRequestID = UUID(); openingPath = nil }
    }

    private var pathBar: some View {
        HStack(spacing: 10) {
            if file != nil || !folder.isEmpty {
                Button {
                    let wasShowingFile = file != nil
                    resetFile()
                    if !wasShowingFile { folder = folder.split(separator: "/").dropLast().joined(separator: "/"); listing = nil }
                } label: { Image(systemName: "chevron.left") }
                    .buttonStyle(.plain).accessibilityLabel(file == nil ? "Up one folder" : "Back to files")
            }
            Text(file?.path ?? (folder.isEmpty ? "/" : folder))
                .font(.callout.monospaced()).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
            Spacer(minLength: 0)
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
                            Image(systemName: entry.type == "tree" ? "folder.fill" : "doc.text")
                                .foregroundStyle(entry.type == "tree" ? WorkspaceStyle.accent(colorScheme) : .secondary)
                                .frame(width: 18)
                            Text(entry.name).lineLimit(1).truncationMode(.middle).foregroundStyle(.primary)
                            Spacer(minLength: 8)
                            Text(entry.type == "tree" ? "Folder" : entry.type == "blob" ? "File" : "Submodule")
                                .font(.caption).foregroundStyle(.secondary).frame(width: 76, alignment: .leading)
                        }.padding(.vertical, 9).contentShape(Rectangle())
                    }.buttonStyle(.plain).disabled(!["tree", "blob"].contains(entry.type) || openingPath != nil)
                        .listRowSeparator(.hidden)
                        .accessibilityLabel("\(entry.name), \(entry.type == "tree" ? "folder" : "file")")
                }
            }.listStyle(.plain).scrollContentBackground(.hidden)
        }
    }

    private func sourceView(_ file: BrowserFile) -> some View {
        ScrollView([.horizontal, .vertical]) {
            if let content = file.content, !content.isEmpty {
                let lines = content.components(separatedBy: "\n")
                HStack(alignment: .top, spacing: 18) {
                    Text(lines.indices.map { String($0 + 1) }.joined(separator: "\n"))
                        .foregroundStyle(.tertiary).multilineTextAlignment(.trailing).accessibilityHidden(true)
                    Text(content).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .topLeading)
                }.font(.system(size: 13, design: .monospaced)).lineSpacing(5).padding(20)
            } else {
                Text(file.omitted ?? "Empty file").foregroundStyle(.secondary).padding(24)
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).id(file.path)
    }

    private func load() async {
        guard repository?.status == "ready" else { return }
        let expected = requestID
        loading = true; error = nil
        defer { if requestID == expected { loading = false } }
        do {
            let ref = selectedBranch.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
            let path = folder.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
            let next: BrowserTree = try await WorkspaceClient(connection: connection).request(base + "/tree?ref=\(ref)&path=\(path)")
            guard !Task.isCancelled, requestID == expected else { return }
            listing = next
            if !selectedFilePath.isEmpty { openFile(path: selectedFilePath, commit: next.commit) }
        } catch { if !Task.isCancelled, requestID == expected { self.error = error.localizedDescription } }
    }

    private func open(_ entry: BrowserTree.Entry) {
        if entry.type == "tree" { resetFile(); folder = entry.path; listing = nil; return }
        guard let commit = listing?.commit else { return }
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
                let encoded = path.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
                let next: BrowserFile = try await WorkspaceClient(connection: connection).request(base + "/blob?ref=\(commit)&path=\(encoded)")
                guard !Task.isCancelled, fileRequestID == token, selectedBranch == expectedBranch, folder == expectedFolder else { return }
                file = next; selectedFilePath = path; openingPath = nil
            } catch { if !Task.isCancelled, fileRequestID == token { self.error = error.localizedDescription; openingPath = nil } }
        }
    }
}

private struct BrowserTree: Decodable {
    let commit: String
    let entries: [Entry]
    struct Entry: Decodable, Identifiable { var id: String { path }; let name: String; let path: String; let type: String }
}
private struct BrowserFile: Decodable { let path: String; let content: String?; let omitted: String? }
