#if os(iOS)
import SwiftUI
import DeployCore

/// The Artifacts sheet from Settings: Make something new, then each project's artifacts.
/// A design opens the canvas the phone already has; a document opens to read.
struct V2ArtifactsView: View {
    let store: V2Store
    /// Closes the sheet, from any page in it.
    var done: (() -> Void)? = nil
    @State private var read = V2Read<V2ArtifactGallery>()
    @State private var making: V2Artifact.Kind?
    @State private var canvas: CanvasTarget?
    @State private var reading: V2Artifact?
    @Environment(\.colorScheme) private var scheme

    struct CanvasTarget: Identifiable, Equatable {
        var projectId: String
        var artifact: String?
        var ref: String?
        var id: String { "\(projectId):\(artifact ?? ""):\(ref ?? "")" }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                V2SettingsGroup(list: true, title: "Make something new") {
                    Button { making = .design } label: {
                        V2SettingsRow(list: true, title: "Design", subtitle: "Boards on a canvas", icon: "square.3.layers.3d") { V2SettingsChevron() }
                    }
                    Divider()
                    Button { making = .document } label: {
                        V2SettingsRow(list: true, title: "Document", subtitle: "Writing with headings", icon: "doc.text") { V2SettingsChevron() }
                    }
                }
                V2LoadRegion(state: read.state, copy: .resource("Artifacts"), lastHeard: store.readDates["artifacts"], retry: { await load() }) {
                    if let gallery = read.value { list(gallery) }
                }.padding(.top, read.state.hasData ? 0 : 20)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.bottom, 24)
        }
        .background(WorkspaceStyle.canvas(scheme)).buttonStyle(.plain)
        .navigationTitle("Artifacts").navigationBarTitleDisplayMode(.inline)
        .task { await load() }.refreshable { await load() }
        .onDisappear { read.leave() }
        .navigationDestination(item: $reading) { artifact in V2ArtifactDocumentView(store: store, artifact: artifact, done: done) }
        .sheet(item: $making) { kind in
            V2NewArtifactView(store: store, kind: kind, projects: read.value?.projects ?? []) { made in
                making = nil
                Task { await load() }
                if made.kind == .design {
                    canvas = CanvasTarget(projectId: made.projectId, artifact: made.artifact, ref: made.branch)
                } else if let opened = read.value?.artifacts.first(where: { $0.projectId == made.projectId && $0.artifact == made.artifact }) {
                    reading = opened
                } else {
                    reading = V2Artifact(projectId: made.projectId, project: read.value?.projects.first(where: { $0.id == made.projectId })?.name ?? made.projectId,
                                         artifact: made.artifact, kind: .document, name: "", boards: nil, updatedAt: nil, branch: made.branch, state: .unproposed)
                }
            }
        }
        .fullScreenCover(item: $canvas, onDismiss: { Task { await load() } }) { target in
            V2DesignView(connection: store.connection, projectId: target.projectId, artifact: target.artifact, ref: target.ref)
        }
    }

    @ViewBuilder private func list(_ gallery: V2ArtifactGallery) -> some View {
        if gallery.artifacts.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Yours").font(.system(size: 13)).frame(minHeight: 18)
                    .foregroundStyle(WorkspaceStyle.tertiary(scheme)).accessibilityAddTraits(.isHeader)
                VStack(alignment: .leading, spacing: 4) {
                    Text("No artifacts yet").font(.system(size: 15, weight: .semibold)).foregroundStyle(WorkspaceStyle.text(scheme))
                    Text("An artifact is a design or a document kept in a project’s repository. Pick a kind above to make the first one.")
                        .font(.system(size: 13)).foregroundStyle(WorkspaceStyle.secondary(scheme))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }.padding(.horizontal, 16).padding(.top, 20)
        } else {
            let groups = gallery.byProject
            ForEach(groups, id: \.project.id) { group in
                V2SettingsGroup(list: true, title: group.project.name,
                                note: group.project.id == groups.last?.project.id ? "Artifacts are kept in each project’s repository. You approve what reaches main." : nil) {
                    ForEach(group.artifacts) { artifact in
                        Button { open(artifact) } label: {
                            V2SettingsRow(list: true, title: artifact.name, subtitle: artifact.subtitle(),
                                          icon: artifact.kind == .design ? "square.3.layers.3d" : "doc.text") { V2SettingsChevron() }
                        }
                        if artifact.id != group.artifacts.last?.id { Divider() }
                    }
                }
            }
        }
    }

    private func open(_ artifact: V2Artifact) {
        if artifact.kind == .document { reading = artifact; return }
        canvas = CanvasTarget(projectId: artifact.projectId, artifact: artifact.artifact, ref: artifact.branch)
    }

    private func load() async {
        await read.load(store: store, key: "artifacts") { try await store.client.artifacts() }
        if V2Evidence.board == "ArtifactsNewPhone", making == nil { making = .design }
        if V2Evidence.board == "ArtifactDocumentPhone", reading == nil {
            let documents = read.value?.artifacts.filter { $0.kind == .document } ?? []
            reading = documents.first { $0.branch == nil } ?? documents.first
        }
    }
}

extension V2Artifact.Kind: Identifiable {
    public var id: String { rawValue }
}

/// A kind asks for a name and the project; Create writes the files on a new branch.
struct V2NewArtifactView: View {
    let store: V2Store
    let kind: V2Artifact.Kind
    let projects: [V2ArtifactGallery.Project]
    let created: (V2Client.CreatedArtifact) -> Void
    @State private var name = ""
    @State private var project = ""
    @State private var busy = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    private var chosen: V2ArtifactGallery.Project? { projects.first { $0.id == project } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    V2Group {
                        HStack(spacing: 12) {
                            Text("Name").font(.system(size: 16))
                            TextField("", text: $name).multilineTextAlignment(.trailing).font(.system(size: 16))
                                .submitLabel(.done).onSubmit { Task { await create() } }
                                .accessibilityLabel("Name")
                        }.padding(.horizontal, 16).frame(minHeight: 52)
                        Divider()
                        Menu {
                            Picker("Project", selection: $project) {
                                ForEach(projects) { Text($0.name).tag($0.id) }
                            }
                        } label: {
                            HStack(spacing: 8) {
                                Text("Project").font(.system(size: 16)).foregroundStyle(WorkspaceStyle.text(scheme))
                                Spacer()
                                Text(chosen?.name ?? "").font(.system(size: 15)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
                                V2SettingsChevron()
                            }.padding(.horizontal, 16).frame(minHeight: 52).contentShape(Rectangle())
                        }.accessibilityLabel("Project").accessibilityValue(chosen?.name ?? "")
                    }.padding(.top, 12)
                    let note = V2Artifacts.createNote(name: name, project: chosen?.name)
                    if let error {
                        Text(error).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.danger(scheme)).padding(.horizontal, 16)
                    } else if !note.isEmpty {
                        Text(note).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme)).padding(.horizontal, 16)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }.padding(.horizontal, 16)
            }
            .background(WorkspaceStyle.canvas(scheme))
            .navigationTitle(kind == .design ? "New design" : "New document").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { Task { await create() } }.fontWeight(.semibold)
                        .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty || chosen == nil)
                }
            }
        }
        .onAppear { if V2Evidence.board == "ArtifactsNewPhone" { name = "Onboarding flow" } }
        // The projects may arrive after the sheet opens.
        .task(id: projects.map(\.id)) {
            guard chosen == nil else { return }
            project = (V2Evidence.board == "ArtifactsNewPhone" ? projects.first(where: { $0.name == "forma" }) : nil)?.id
                ?? projects.first?.id ?? ""
        }
    }

    private func create() async {
        guard !busy, let chosen, !name.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        busy = true
        defer { busy = false }
        do { created(try await store.client.createArtifact(kind: kind, name: name, project: chosen.id)) }
        catch { self.error = coordinatorErrorDescription(error) }
    }
}

/// A document, to read. Editing a document on iPhone is not drawn yet.
struct V2ArtifactDocumentView: View {
    let store: V2Store
    let artifact: V2Artifact
    var done: (() -> Void)? = nil
    @State private var read = V2Read<V2ArtifactDocument>()
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ScrollView {
            V2LoadRegion(state: read.state, copy: .resource("Document", plural: false), lastHeard: store.readDates[key], rows: 4, icons: false, retry: { await load() }) {
                if let document = read.value { page(document) }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 32)
        }
        .background(WorkspaceStyle.canvas(scheme))
        .navigationTitle("Document").navigationBarTitleDisplayMode(.inline)
        .toolbar { if let done { Button("Done", action: done) } }
        .task { await load() }.refreshable { await load() }
        .onDisappear { read.leave() }
    }
    private var key: String { "artifact-document:\(artifact.projectId):\(artifact.artifact ?? "")" }

    @ViewBuilder private func page(_ document: V2ArtifactDocument) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(document.title).font(.system(size: 22, weight: .semibold)).foregroundStyle(WorkspaceStyle.text(scheme))
                .accessibilityAddTraits(.isHeader)
            Text(document.meta()).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
                .padding(.top, 4).padding(.bottom, 20)
            ForEach(Array(document.blocks.enumerated()), id: \.offset) { _, block in blockView(block) }
        }.textSelection(.enabled)
    }

    @ViewBuilder private func blockView(_ block: V2Artifacts.Block) -> some View {
        let body = Font.system(size: 17)
        switch block {
        case .paragraph(let text):
            inline(text).font(body).lineSpacing(5).padding(.bottom, 14)
        case .heading(let text):
            inline(text).font(.system(size: 17, weight: .semibold)).padding(.top, 8).padding(.bottom, 10)
                .accessibilityAddTraits(.isHeader)
        case .bullet(let text):
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("•").font(body)
                inline(text).font(body).lineSpacing(5)
            }.padding(.leading, 6).padding(.bottom, 6)
        case .number(let number, let text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("\(number).").font(body).monospacedDigit()
                inline(text).font(body).lineSpacing(5)
            }.padding(.leading, 6).padding(.bottom, 6)
        case .code(let text):
            Text(text).font(.system(size: 13, design: .monospaced)).padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(WorkspaceStyle.line(scheme).opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
                .padding(.bottom, 14)
        }
    }
    /// Bold, italic, code and links, as markdown shows them.
    private func inline(_ text: String) -> Text {
        let styled = (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
        return Text(styled).foregroundStyle(WorkspaceStyle.text(scheme))
    }

    private func load() async {
        guard let name = artifact.artifact else { return }
        await read.load(store: store, key: key) { try await store.client.artifactDocument(project: artifact.projectId, artifact: name) }
    }
}
#endif
