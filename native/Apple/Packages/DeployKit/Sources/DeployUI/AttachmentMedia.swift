import SwiftUI
import DeployCore
import PhotosUI
import AVKit
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
    @Environment(\.markupActions) private var markupActions
    @Environment(\.mediaConnection) private var connection
    @Environment(\.taskMedia) private var attachments
    @Environment(\.colorScheme) private var scheme
    @State private var data: Data?
    @State private var failed = false
    @State private var showViewer = false
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    @Environment(\.openMediaViewer) private var openMedia
    @FocusState private var openerFocused: Bool
    @AccessibilityFocusState private var accessibleOpenerFocused: Bool
    private var row: MediaAttachment? { attachments.first { $0.id == id } }
    var body: some View {
        Group {
            if let row, row.kind == "video" {
                Button { openViewer() } label: { VideoPoster(attachment: row, connection: connection, compact: compact) }.buttonStyle(.plain).accessibilityLabel("Play \(caption)")
            } else if let data, let image = platformImage(data) {
                Button { openViewer() } label: {
                    // A fixed height with the image's own aspect ratio; only maximums let a scroll strip squash it.
                    image.resizable().aspectRatio(contentMode: .fit)
                        .frame(height: compact ? WorkspaceStyle.mediaStripHeight : WorkspaceStyle.mediaThumbnailHeight)
                        .frame(maxWidth: compact ? WorkspaceStyle.mediaStripWidth * 2 : WorkspaceStyle.mediaThumbnailWidth * 1.5)
                        .clipShape(RoundedRectangle(cornerRadius: WorkspaceStyle.radius))
                        .overlay(RoundedRectangle(cornerRadius: WorkspaceStyle.radius).strokeBorder(WorkspaceStyle.line(scheme), lineWidth: 1))
                }.buttonStyle(.plain).accessibilityLabel("Open \(caption)")
            } else if failed || data != nil { Label("Image unavailable", systemImage: "photo").foregroundStyle(.secondary) }
            else { ProgressView().controlSize(.small) }
        }
        .focused($openerFocused)
        .accessibilityFocused($accessibleOpenerFocused)
        .task(id: connection.flatMap { try? AuthenticatedImageCache.key(connection: $0, attachmentId: id) } ?? id) {
            data = nil; failed = false
            guard let connection else { failed = true; return }
            if row?.kind == "video" { return }
            do { data = try await AuthenticatedImageCache.shared.data(connection: connection, attachmentId: id) }
            catch { failed = true }
        }
        .sheet(isPresented: $showViewer, onDismiss: restoreFocus) {
            viewer
                #if os(iOS)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
                .presentationCornerRadius(0)
                #endif
        }
    }
    private var viewer: some View {
        AttachmentViewer(initialId: id, caption: caption)
            .environment(\.mediaConnection, connection)
            .environment(\.taskMedia, attachments)
            .environment(\.markupActions, markupActions)
    }
    private func restoreFocus() { openerFocused = true; accessibleOpenerFocused = true }
    private func openViewer() {
        #if os(iOS)
        if horizontalSizeClass == .compact { showViewer = true; return }
        #endif
        if let openMedia {
            openMedia(MediaViewerPresentation(content: { close in
                AnyView(AttachmentViewer(initialId: id, caption: caption, onClose: close)
                    .environment(\.mediaConnection, connection)
                    .environment(\.taskMedia, attachments)
                    .environment(\.markupActions, markupActions))
            }, restoreFocus: restoreFocus))
        } else { showViewer = true }
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
    /// Images sent with your own message sit under it, at the trailing edge.
    var trailing = false
    var body: some View {
        if !rows.isEmpty {
            if computer { DisclosureGroup("\(screenshotCount(rows.filter { $0.kind == "image" }.count))\(rows.contains { $0.kind == "video" } ? " and recording" : "") from computer use") { strip }.font(.caption).foregroundStyle(.secondary) }
            else { strip }
        }
    }
    private var strip: some View {
        ScrollView(.horizontal) { HStack(spacing: WorkspaceStyle.space2) {
            ForEach(rows) { attachment in
                if ["image", "video"].contains(attachment.kind) { AttachmentThumbnail(id: attachment.id, caption: attachment.displayCaption, compact: computer) }
                else { AttachmentDownload(attachment: attachment) }
            }
        }}
        .scrollIndicators(.hidden)
        .defaultScrollAnchor(trailing ? .trailing : .leading)
        .frame(maxWidth: .infinity, alignment: trailing ? .trailing : .leading)
        .fixedSize(horizontal: false, vertical: true)
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
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var selected: Int?
    @State private var player: AVPlayer?
    @State private var data: Data?
    @State private var error: String?
    @State private var shareFile: URL?
    @State private var scale = 1.0
    @GestureState private var magnification = 1.0
    @FocusState private var closeFocused: Bool
    private var group: [MediaAttachment] { attachments.filter { ["image", "video"].contains($0.kind) } }
    private var navigation: MediaNavigation {
        var value = MediaNavigation(ids: group.map(\.id), initialID: initialId)
        if let selected { value.select(selected) }
        return value
    }
    private var position: Int { navigation.index }
    private var id: String { navigation.selectedID ?? initialId }
    private var row: MediaAttachment? { group.first { $0.id == id } }
    private var count: String { "\(position + 1) of \(max(1, group.count))" }
    private var mediaLabel: String { "\(row?.kind == "video" ? "Video" : "Image") \(count): \(row?.displayCaption ?? caption)" }
    private func close() { player?.pause(); if let onClose { onClose() } else { dismiss() } }
    private func select(_ index: Int) {
        var value = navigation; value.select(index)
        guard value.index != position else { return }
        player?.pause(); scale = 1; selected = value.index
    }
    var body: some View {
        VStack(spacing: WorkspaceStyle.space3) {
            header
            ZStack {
                #if os(iOS)
                TabView(selection: Binding(get: { position }, set: { select($0) })) {
                    ForEach(Array(group.enumerated()), id: \.element.id) { index, item in
                        Group {
                            if index == position { media }
                            else { MediaFilmThumbnail(attachment: item).frame(maxWidth: .infinity, maxHeight: .infinity) }
                        }.tag(index)
                    }
                }.tabViewStyle(.page(indexDisplayMode: .never))
                #else
                media
                    .background {
                        if row?.kind != "video" { MediaWheelInput(zoom: $scale, step: { select(position + $0) }) }
                    }
                #endif
                if group.count > 1 {
                    HStack {
                        WorkspaceIconButton(label: "Previous media", icon: .chevronLeft, size: .touch, shortcut: "←") { select(position - 1) }.disabled(!navigation.canGoBack)
                        Spacer()
                        WorkspaceIconButton(label: "Next media", icon: .chevron, size: .touch, shortcut: "→") { select(position + 1) }.disabled(!navigation.canGoForward)
                    }.padding(.horizontal, WorkspaceStyle.space2)
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            if group.count > 1 { filmstrip }
        }
        .padding(WorkspaceStyle.space4)
        .background(WorkspaceStyle.surface(scheme))
        .onAppear { closeFocused = true }
        .onKeyPress(keys: [.leftArrow, .rightArrow, .home, .end, .escape]) { press in
            guard press.modifiers.intersection([.command, .control, .option]).isEmpty else { return .ignored }
            switch press.key {
            case .leftArrow: select(position - 1)
            case .rightArrow: select(position + 1)
            case .home: select(0)
            case .end: select(group.count - 1)
            case .escape: close()
            default: return .ignored
            }
            return .handled
        }
        .task(id: id) { await loadMedia() }
        .onDisappear { player?.pause(); if let shareFile { try? FileManager.default.removeItem(at: shareFile) } }
    }
    private var header: some View {
        HStack(spacing: WorkspaceStyle.space2) {
            VStack(alignment: .leading) {
                Text(count).font(.headline)
                Text(row?.displayCaption ?? caption).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }.frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .ignore).accessibilityLabel(mediaLabel)
            WorkspaceActionCluster {
                if let row, row.kind != "video", data != nil { ImageMarkupButton(attachment: row, done: close) }
                if let shareFile {
                    ShareLink(item: shareFile) { WorkspaceToolbarIcon("Share media", icon: .download) }
                        .buttonStyle(WorkspaceToolbarButtonStyle()).accessibilityLabel("Share media").help("Share media")
                }
                WorkspaceIconButton(label: "Close media viewer", icon: .close, shortcut: "Esc") { close() }
                    .focused($closeFocused).keyboardShortcut(.cancelAction)
            }
        }
    }
    private var media: some View {
        GeometryReader { geometry in
            if let player { VideoPlayer(player: player).accessibilityLabel(mediaLabel) }
            else if let data, let image = platformImage(data) {
                ScrollView([.horizontal, .vertical]) {
                    image.resizable().scaledToFit()
                        .frame(width: geometry.size.width * scale * magnification, height: geometry.size.height * scale * magnification)
                        .gesture(MagnificationGesture().updating($magnification) { value, state, _ in state = value }
                            .onEnded { scale = min(5, max(1, scale * $0)) })
                        .onTapGesture(count: 2) { withAnimation(WorkspaceStyle.Motion.standard(reduceMotion: reduceMotion)) { scale = scale > 1 ? 1 : 2.5 } }
                        .accessibilityLabel(mediaLabel)
                }.scrollIndicators(.hidden).defaultScrollAnchor(.center)
                    .scrollDisabled(scale == 1)
                    .id(id)
            } else if let error {
                ContentUnavailableView("Media unavailable", systemImage: "photo", description: Text(error))
            } else { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
        }
    }
    private var filmstrip: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                HStack(spacing: WorkspaceStyle.space2) {
                    ForEach(Array(group.enumerated()), id: \.element.id) { index, item in
                        Button { select(index) } label: {
                            MediaFilmThumbnail(attachment: item)
                                .frame(width: WorkspaceStyle.mediaStripWidth, height: WorkspaceStyle.mediaStripHeight)
                                .clipped()
                                .overlay(RoundedRectangle(cornerRadius: WorkspaceStyle.radius).strokeBorder(index == position ? WorkspaceStyle.accent(scheme) : .clear, lineWidth: 2))
                        }.buttonStyle(.plain).id(item.id)
                            .accessibilityLabel("\(item.kind == "video" ? "Video" : "Image") \(index + 1) of \(group.count): \(item.displayCaption)")
                            .accessibilityAddTraits(index == position ? .isSelected : [])
                    }
                }.padding(WorkspaceStyle.space1)
            }.fixedSize(horizontal: false, vertical: true)
                .onAppear { proxy.scrollTo(id, anchor: .center) }
                .onChange(of: id) { _, id in proxy.scrollTo(id, anchor: .center) }
        }
    }
    private func loadMedia() async {
        if let shareFile { try? FileManager.default.removeItem(at: shareFile) }
        player?.pause(); player = nil; data = nil; error = nil; scale = 1; shareFile = nil
        guard let connection else { error = "Sign in again"; return }
        do {
            if let row, row.kind == "video" {
                player = AVPlayer(playerItem: AVPlayerItem(asset: try AuthenticatedMedia.asset(connection: connection, attachmentId: id)))
                let file = try await AuthenticatedMedia.download(connection: connection, attachment: row)
                guard !Task.isCancelled else { try? FileManager.default.removeItem(at: file); return }
                shareFile = file
            } else {
                let bytes = try await AuthenticatedImageCache.shared.data(connection: connection, attachmentId: id)
                try Task.checkCancellation()
                data = bytes
                let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "-" + (row?.downloadName ?? "image.png"))
                try bytes.write(to: url, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
                shareFile = url
            }
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

private struct MediaFilmThumbnail: View {
    let attachment: MediaAttachment
    @Environment(\.mediaConnection) private var connection
    @State private var data: Data?
    var body: some View {
        Group {
            if attachment.kind == "video" { VideoPoster(attachment: attachment, connection: connection, compact: true) }
            else if let data, let image = platformImage(data) { image.resizable().scaledToFit() }
            else { Image(systemName: "photo").accessibilityHidden(true) }
        }.task(id: attachment.id) {
            guard let connection, attachment.kind != "video" else { return }
            data = try? await AuthenticatedImageCache.shared.data(connection: connection, attachmentId: attachment.id)
        }
    }
}

struct AttachmentComposerControl: View {
    @Bindable var store: WorkspaceStore
    var add: ((Data, String) async -> Void)? = nil
    var addFile: ((URL) async -> Void)? = nil
    @State private var photos: [PhotosPickerItem] = []
    @State private var openFiles = false
    var body: some View {
        Group {
            #if os(iOS)
            HStack(spacing: WorkspaceStyle.space2) {
            PhotosPicker(selection: $photos, maxSelectionCount: 20, matching: .any(of: [.images, .videos])) { Image(systemName: "paperclip").frame(width: WorkspaceStyle.controlSize, height: WorkspaceStyle.controlSize) }
                .accessibilityLabel("Attach images or videos")
                .onChange(of: photos) { _, items in Task {
                    for item in items {
                        do {
                            if item.supportedContentTypes.contains(where: { $0.conforms(to: .movie) || $0.conforms(to: .video) }) {
                                guard let video = try await item.loadTransferable(type: PickedVideo.self) else { store.error = "Video unavailable"; continue }
                                defer { try? FileManager.default.removeItem(at: video.url) }
                                await uploadFile(video.url)
                            } else if let data = try await item.loadTransferable(type: Data.self) { await upload(normalizedImageData(data), name: "Photo") }
                            else { store.error = "Image unavailable" }
                        } catch { store.error = error.localizedDescription }
                    }
                    photos = []
                }}
            PasteButton(supportedContentTypes: [.png, .jpeg, .gif, .webP, .tiff, .movie, .video]) { providers in
                AttachmentComposerInput(store: store, add: add, addFile: addFile).receive(providers)
            }.labelStyle(.iconOnly).accessibilityLabel("Paste image or video")
            }
            #else
            WorkspaceIconButton(label: "Attach images or videos", icon: .plus) { openFiles = true }
                .fileImporter(isPresented: $openFiles, allowedContentTypes: [.png, .jpeg, .gif, .webP, .movie, .video], allowsMultipleSelection: true) { result in
                    if case .success(let urls) = result { Task {
                        for url in urls { let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }; await uploadFile(url) }
                    }}
                }
            #endif
        }.buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel("Attach images or videos").disabled(store.uploadingAttachment || store.busy)
    }
    private func uploadFile(_ url: URL) async {
        if let type = UTType(filenameExtension: url.pathExtension), type.conforms(to: .image), ![UTType.png, .jpeg, .gif, .webP].contains(type) {
            do {
                guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 20 * 1024 * 1024 else { store.error = "Images must be at most 20 MB."; return }
                await upload(normalizedImageData(try Data(contentsOf: url)), name: url.lastPathComponent)
            } catch { store.error = error.localizedDescription }
            return
        }
        if let addFile { await addFile(url) } else { await store.addAttachment(file: url) }
    }
    private func upload(_ data: Data, name: String) async {
        if let add { await add(data, name) } else { await store.addAttachment(data: data, name: name) }
    }

}
struct AttachmentComposerInput: ViewModifier {
    let store: WorkspaceStore
    var add: ((Data, String) async -> Void)? = nil
    var addFile: ((URL) async -> Void)? = nil
    func body(content: Content) -> some View {
        #if os(macOS)
        content.onPasteCommand(of: [.png, .jpeg, .gif, .webP, .tiff, .movie, .video]) { providers in receive(providers) }
            .onDrop(of: [.fileURL, .png, .jpeg, .gif, .webP, .tiff, .movie, .video], isTargeted: nil) { providers in receive(providers); return true }
        #else
        content.onDrop(of: [.fileURL, .png, .jpeg, .gif, .webP, .tiff, .movie, .video], isTargeted: nil) { providers in receive(providers); return true }
        #endif
    }
    fileprivate func receive(_ providers: [NSItemProvider]) {
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                _ = provider.loadDataRepresentation(forTypeIdentifier: UTType.fileURL.identifier) { data, _ in
                    if let data, let url = URL(dataRepresentation: data, relativeTo: nil) { Task { @MainActor in await uploadFile(url) } }
                }
            } else if let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .movie) == true }) {
                _ = provider.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                    guard let url else { return }
                    let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "-" + url.lastPathComponent)
                    do {
                        try FileManager.default.copyItem(at: url, to: file)
                        Task { @MainActor in defer { try? FileManager.default.removeItem(at: file) }; await uploadFile(file) }
                    } catch { Task { @MainActor in store.error = error.localizedDescription } }
                }
            } else if let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true }) {
                _ = provider.loadDataRepresentation(forTypeIdentifier: type) { data, _ in
                    if let data { Task { @MainActor in await upload(normalizedImageData(data), name: "Pasted image") } }
                }
            }
        }
    }
    private func uploadFile(_ url: URL) async {
        if let type = UTType(filenameExtension: url.pathExtension), type.conforms(to: .image), ![UTType.png, .jpeg, .gif, .webP].contains(type) {
            do {
                guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 20 * 1024 * 1024 else { store.error = "Images must be at most 20 MB."; return }
                await upload(normalizedImageData(try Data(contentsOf: url)), name: url.lastPathComponent)
            } catch { store.error = error.localizedDescription }
            return
        }
        if let addFile { await addFile(url) } else { await store.addAttachment(file: url) }
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

private func screenshotCount(_ count: Int) -> String { count == 1 ? "1 screenshot" : "\(count) screenshots" }
