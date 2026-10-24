import SwiftUI
import DeployCore

/// Files a job returned, under its Activity row: media thumbnails open the shared media viewer
/// (its filmstrip scoped to this job), text opens a bounded preview, skipped files say why.
struct JobArtifactsView: View {
    let job: WorkspaceJob
    @Environment(\.taskMedia) private var attachments
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let rows = job.artifactRows(attachments: attachments)
        if job.awaitsArtifacts {
            Text("Files upload when the job ends").font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
        } else if !rows.isEmpty {
            VStack(alignment: .leading, spacing: WorkspaceStyle.space1) {
                if !rows.media.isEmpty { AttachmentStrip(rows: rows.media).environment(\.taskMedia, rows.media) }
                if !rows.files.isEmpty {
                    ScrollView(.horizontal) {
                        HStack(spacing: WorkspaceStyle.space2) { ForEach(rows.files) { TextArtifactButton(attachment: $0) } }
                    }.scrollIndicators(.hidden)
                }
                if !rows.skipped.isEmpty {
                    DisclosureGroup("\(rows.skipped.count) file\(rows.skipped.count == 1 ? "" : "s") not returned") {
                        VStack(alignment: .leading, spacing: WorkspaceStyle.space1) {
                            ForEach(rows.skipped) { entry in
                                (Text(entry.path).font(.system(.caption, design: .monospaced)) + Text(" \(entry.skipped ?? "")"))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }.padding(.top, WorkspaceStyle.space1)
                    }.font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Job artifacts")
            .accessibilityIdentifier("job-artifacts-\(job.id)")
        }
    }
}

private struct TextArtifactButton: View {
    let attachment: MediaAttachment
    @State private var open = false
    @Environment(\.mediaConnection) private var connection
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Button { open = true } label: {
            HStack(spacing: WorkspaceStyle.space1) {
                WorkspaceGlyph(name: .file, size: WorkspaceStyle.IconAction.compactGlyph)
                Text(attachment.displayCaption).lineLimit(1).truncationMode(.middle)
                Text(ArtifactSize.label(attachment.size)).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
            }.font(WorkspaceStyle.metadata).frame(minHeight: WorkspaceStyle.controlSize)
        }
        .buttonStyle(.workspaceQuiet)
        .accessibilityLabel("Open \(attachment.name), \(ArtifactSize.label(attachment.size))")
        .sheet(isPresented: $open) {
            TextArtifactViewer(attachment: attachment, close: { open = false })
                .environment(\.mediaConnection, connection)
                #if os(macOS)
                .frame(minWidth: 560, idealWidth: 760, minHeight: 420, idealHeight: 620)
                #else
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
                #endif
        }
    }
}

/// Mirrors the web preview: the media viewer's header and actions over a monospaced text body.
private struct TextArtifactViewer: View {
    let attachment: MediaAttachment
    let close: () -> Void
    /// Previews show a bounded prefix; Share hands over the whole (already redacted) file.
    private static let previewBytes = 64 * 1024
    @Environment(\.mediaConnection) private var connection
    @Environment(\.colorScheme) private var scheme
    @State private var text: String?
    @State private var error: String?
    @State private var wrap = true
    @State private var shareFile: URL?
    @FocusState private var closeFocused: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: WorkspaceStyle.space3) {
            HStack(spacing: WorkspaceStyle.space2) {
                VStack(alignment: .leading) {
                    Text(attachment.name).font(.headline).lineLimit(1).truncationMode(.middle)
                    Text([attachment.caption ?? "", ArtifactSize.label(attachment.size)].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }.frame(maxWidth: .infinity, alignment: .leading)
                WorkspaceActionCluster {
                    if let text { WorkspaceCopyButton(label: "Copy text", text: text, size: .default) }
                    WorkspaceIconButton(label: "Wrap lines", icon: .wrap, pressed: wrap) { wrap.toggle() }
                    if let shareFile {
                        ShareLink(item: shareFile) { WorkspaceToolbarIcon("Share file", icon: .download) }
                            .buttonStyle(WorkspaceToolbarButtonStyle()).accessibilityLabel("Share file").help("Share file")
                    }
                    WorkspaceIconButton(label: "Close preview", icon: .close, shortcut: "Esc") { close() }
                        .focused($closeFocused).keyboardShortcut(.cancelAction)
                }
            }
            Group {
                if let error {
                    ContentUnavailableView("File unavailable", systemImage: "doc.text", description: Text(error))
                } else if let text {
                    ScrollView(wrap ? .vertical : [.horizontal, .vertical]) {
                        Text(text).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                            .fixedSize(horizontal: !wrap, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(WorkspaceStyle.space3)
                    }.background(WorkspaceStyle.raised(scheme), in: RoundedRectangle(cornerRadius: WorkspaceStyle.radius))
                } else { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            if attachment.size > Self.previewBytes {
                Text("Showing the first 64 KB. Share the file for the rest.").font(WorkspaceStyle.metadata).foregroundStyle(.secondary)
            }
        }
        .padding(WorkspaceStyle.space4)
        .background(WorkspaceStyle.surface(scheme))
        .onAppear { closeFocused = true }
        .task(id: attachment.id) { await load() }
        .onDisappear { if let shareFile { try? FileManager.default.removeItem(at: shareFile) } }
    }
    private func load() async {
        guard let connection else { error = "Sign in again"; return }
        do {
            let data = try await AuthenticatedImageCache.shared.data(connection: connection, attachmentId: attachment.id)
            try Task.checkCancellation()
            text = String(decoding: data.prefix(Self.previewBytes), as: UTF8.self)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "-" + attachment.downloadName)
            try data.write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            shareFile = url
        } catch { if !Task.isCancelled { self.error = "This file could not be loaded." } }
    }
}
