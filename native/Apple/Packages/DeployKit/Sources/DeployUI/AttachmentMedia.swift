import SwiftUI
import DeployCore
import PhotosUI
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#else
import UIKit
#endif

private struct MediaConnectionKey: EnvironmentKey { static let defaultValue: Connection? = nil }
private struct TaskMediaKey: EnvironmentKey { static let defaultValue: [MediaAttachment] = [] }
extension EnvironmentValues {
    var mediaConnection: Connection? { get { self[MediaConnectionKey.self] } set { self[MediaConnectionKey.self] = newValue } }
    var taskMedia: [MediaAttachment] { get { self[TaskMediaKey.self] } set { self[TaskMediaKey.self] = newValue } }
}

struct AttachmentThumbnail: View {
    let id: String
    let caption: String
    let compact: Bool
    nonisolated init(id: String, caption: String = "Image", compact: Bool = false) { self.id = id; self.caption = caption; self.compact = compact }
    @Environment(\.mediaConnection) private var connection
    @Environment(\.taskMedia) private var attachments
    @State private var data: Data?
    @State private var failed = false
    @State private var showViewer = false
    #if os(macOS)
    @State private var viewerWindow: NSWindow?
    #endif
    var body: some View {
        Group {
            if let data, let image = platformImage(data) {
                Button { openViewer() } label: {
                    image.resizable().scaledToFit().frame(maxWidth: compact ? WorkspaceStyle.mediaStripWidth : WorkspaceStyle.mediaThumbnailWidth, maxHeight: compact ? WorkspaceStyle.mediaStripHeight : WorkspaceStyle.mediaThumbnailHeight).clipShape(RoundedRectangle(cornerRadius: WorkspaceStyle.radius))
                }.buttonStyle(.plain).accessibilityLabel("Open \(caption)")
            } else if failed || data != nil { Label("Image unavailable", systemImage: "photo").foregroundStyle(.secondary) }
            else { ProgressView().controlSize(.small) }
        }
        .task(id: connection.flatMap { try? AuthenticatedImageCache.key(connection: $0, attachmentId: id) } ?? id) {
            data = nil; failed = false
            guard let connection else { failed = true; return }
            do { data = try await AuthenticatedImageCache.shared.data(connection: connection, attachmentId: id) }
            catch { failed = true }
        }
        #if os(iOS)
        .fullScreenCover(isPresented: $showViewer) { AttachmentViewer(initialId: id, caption: caption).environment(\.mediaConnection, connection).environment(\.taskMedia, attachments) }
        #endif
    }
    private func openViewer() {
        #if os(macOS)
        if let viewerWindow, viewerWindow.isVisible { viewerWindow.makeKeyAndOrderFront(nil); return }
        let window = NSWindow(contentRect: NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: WorkspaceStyle.mediaViewerWidth, height: WorkspaceStyle.mediaViewerHeight), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = caption
        window.contentView = NSHostingView(rootView: AttachmentViewer(initialId: id, caption: caption, onClose: { [weak window] in window?.close() }).environment(\.mediaConnection, connection).environment(\.taskMedia, attachments))
        viewerWindow = window
        window.makeKeyAndOrderFront(nil)
        window.toggleFullScreen(nil)
        #else
        showViewer = true
        #endif
    }

}
private func platformImage(_ data: Data) -> Image? {
    #if os(macOS)
    guard let image = NSImage(data: data) else { return nil }; return Image(nsImage: image)
    #else
    guard let image = UIImage(data: data) else { return nil }; return Image(uiImage: image)
    #endif
}
struct AttachmentStrip: View {
    let rows: [MediaAttachment]
    var computer = false
    var body: some View {
        if !rows.isEmpty {
            if computer { DisclosureGroup("\(rows.count) screenshots from computer use") { strip }.font(.caption).foregroundStyle(.secondary) }
            else { strip }
        }
    }
    private var strip: some View {
        ScrollView(.horizontal) { HStack(spacing: WorkspaceStyle.space2) {
            ForEach(rows) { attachment in
                if attachment.kind == "image" { AttachmentThumbnail(id: attachment.id, caption: attachment.displayCaption, compact: true) }
                else { AttachmentDownload(attachment: attachment) }
            }
        }}.fixedSize(horizontal: false, vertical: true)
    }
}
private struct AttachmentDownload: View {
    let attachment: MediaAttachment
    @Environment(\.mediaConnection) private var connection
    @State private var file: URL?
    @State private var error: String?
    var body: some View {
        HStack {
            if let file { ShareLink(item: file) { Label(attachment.name, systemImage: "square.and.arrow.up") }.buttonStyle(.workspaceLink) }
            else { Button(attachment.name) { Task {
                guard let connection else { return }
                do {
                    let data = try await AuthenticatedImageCache.shared.data(connection: connection, attachmentId: attachment.id)
                    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "-" + attachment.downloadName)
                    try data.write(to: url, options: .atomic); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path); file = url
                } catch { self.error = "File unavailable" }
            }}.buttonStyle(.workspaceLink) }
            if let error { Text(error).foregroundStyle(.secondary) }
        }.onDisappear { if let file { try? FileManager.default.removeItem(at: file) } }
    }
}
private struct AttachmentViewer: View {
    let initialId: String
    let caption: String
    var onClose: (() -> Void)? = nil
    @Environment(\.mediaConnection) private var connection
    @Environment(\.taskMedia) private var attachments
    @Environment(\.dismiss) private var dismiss
    @State private var selected = ""
    @State private var data: Data?
    @State private var error: String?
    @State private var shareFile: URL?
    @State private var scale = 1.0
    @GestureState private var magnification = 1.0
    private var id: String { selected.isEmpty ? initialId : selected }
    private var row: MediaAttachment? { attachments.first { $0.id == id } }
    private var group: [MediaAttachment] {
        guard let runId = attachments.first(where: { $0.id == initialId })?.runId else { return attachments.filter { $0.id == initialId } }
        return attachments.filter { $0.runId == runId && $0.kind == "image" }
    }
    var body: some View {
        VStack(spacing: WorkspaceStyle.space3) {
            HStack {
                Button("Close") { if let onClose { onClose() } else { dismiss() } }.buttonStyle(.workspaceLink)
                Button("Previous") { step(-1) }.buttonStyle(.workspaceLink).disabled((group.firstIndex { $0.id == id } ?? 0) == 0)
                Button("Next") { step(1) }.buttonStyle(.workspaceLink).disabled((group.firstIndex { $0.id == id } ?? 0) >= group.count - 1)
                Slider(value: $scale, in: 1...5).accessibilityLabel("Zoom")
                if let shareFile { ShareLink(item: shareFile).buttonStyle(.workspaceLink) }
            }
            GeometryReader { geometry in
                ScrollView([.horizontal, .vertical]) {
                    if let data, let image = platformImage(data) {
                        image.resizable().scaledToFit().frame(width: geometry.size.width * scale * magnification, height: geometry.size.height * scale * magnification)
                            .gesture(MagnificationGesture().updating($magnification) { value, state, _ in state = value }.onEnded { scale = min(5, max(1, scale * $0)) })
                    } else if let error { Text("Image unavailable: \(error)") }
                    else if data != nil { Text("Image unavailable") }
                    else { ProgressView() }
                }
            }
            Text(row?.displayCaption ?? caption).font(.caption).foregroundStyle(.secondary)
        }.padding(WorkspaceStyle.space4)
        .task(id: id) {
            if let shareFile { try? FileManager.default.removeItem(at: shareFile) }
            data = nil; error = nil; scale = 1; shareFile = nil
            guard let connection else { error = "Sign in again"; return }
            do {
                let bytes = try await AuthenticatedImageCache.shared.data(connection: connection, attachmentId: id)
                data = bytes
                let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "-" + (row?.downloadName ?? "image.png"))
                try bytes.write(to: url, options: .atomic); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path); shareFile = url
            } catch { self.error = error.localizedDescription }
        }
        .onDisappear { if let shareFile { try? FileManager.default.removeItem(at: shareFile) } }
    }
    private func step(_ offset: Int) {
        guard let index = group.firstIndex(where: { $0.id == id }), group.indices.contains(index + offset) else { return }
        selected = group[index + offset].id
    }
}

struct AttachmentComposerControl: View {
    @Bindable var store: WorkspaceStore
    var add: ((Data, String) async -> Void)? = nil
    @State private var photos: [PhotosPickerItem] = []
    @State private var openFiles = false
    var body: some View {
        Group {
            #if os(iOS)
            HStack(spacing: WorkspaceStyle.space2) {
            PhotosPicker(selection: $photos, maxSelectionCount: 20, matching: .images) { Image(systemName: "paperclip").frame(width: WorkspaceStyle.controlSize, height: WorkspaceStyle.controlSize) }
                .accessibilityLabel("Attach images")
                .onChange(of: photos) { _, items in Task {
                    for item in items {
                        do {
                            if let data = try await item.loadTransferable(type: Data.self) { await upload(normalizedImageData(data), name: "Photo") }
                            else { store.error = "Image unavailable" }
                        } catch { store.error = error.localizedDescription }
                    }
                    photos = []
                }}
            PasteButton(supportedContentTypes: [.png, .jpeg, .gif, .webP, .tiff]) { providers in
                AttachmentComposerInput(store: store, add: add).receive(providers)
            }.labelStyle(.iconOnly).accessibilityLabel("Paste image")
            }
            #else
            Button { openFiles = true } label: { Image(systemName: "paperclip").frame(width: WorkspaceStyle.controlSize, height: WorkspaceStyle.controlSize) }
                .fileImporter(isPresented: $openFiles, allowedContentTypes: [.png, .jpeg, .gif, .webP], allowsMultipleSelection: true) { result in
                    if case .success(let urls) = result { Task {
                        for url in urls { let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }; if let data = try? Data(contentsOf: url) { await upload(data, name: url.lastPathComponent) } }
                    }}
                }
            #endif
        }.buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel("Attach images").disabled(store.uploadingAttachment || store.busy)
    }
    private func upload(_ data: Data, name: String) async {
        if let add { await add(data, name) } else { await store.addAttachment(data: data, name: name) }
    }

}
struct AttachmentComposerInput: ViewModifier {
    let store: WorkspaceStore
    var add: ((Data, String) async -> Void)? = nil
    func body(content: Content) -> some View {
        #if os(macOS)
        content.onPasteCommand(of: [.png, .jpeg, .gif, .webP, .tiff]) { providers in receive(providers) }
            .onDrop(of: [.fileURL, .png, .jpeg, .gif, .webP, .tiff], isTargeted: nil) { providers in receive(providers); return true }
        #else
        content.onDrop(of: [.fileURL, .png, .jpeg, .gif, .webP, .tiff], isTargeted: nil) { providers in receive(providers); return true }
        #endif
    }
    fileprivate func receive(_ providers: [NSItemProvider]) {
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                _ = provider.loadDataRepresentation(forTypeIdentifier: UTType.fileURL.identifier) { data, _ in
                    if let data, let url = URL(dataRepresentation: data, relativeTo: nil), let bytes = try? Data(contentsOf: url) { Task { @MainActor in await upload(normalizedImageData(bytes), name: url.lastPathComponent) } }
                }
            } else if let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true }) {
                _ = provider.loadDataRepresentation(forTypeIdentifier: type) { data, _ in
                    if let data { Task { @MainActor in await upload(normalizedImageData(data), name: "Pasted image") } }
                }
            }
        }
    }
    private func upload(_ data: Data, name: String) async {
        if let add { await add(data, name) } else { await store.addAttachment(data: data, name: name) }
    }

}

/// Preserve supported image encodings, convert Photos/pasteboard HEIC or TIFF to PNG.
private func normalizedImageData(_ data: Data) -> Data {
    let prefix = Array(data.prefix(12))
    if prefix.starts(with: [137, 80, 78, 71]) || prefix.starts(with: [255, 216]) || prefix.starts(with: [71, 73, 70, 56]) ||
        (prefix.starts(with: [82, 73, 70, 70]) && Array(prefix.dropFirst(8)) == [87, 69, 66, 80]) { return data }
    #if os(macOS)
    guard let image = NSImage(data: data), let tiff = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) else { return data }
    return png
    #else
    return UIImage(data: data)?.pngData() ?? data
    #endif
}
