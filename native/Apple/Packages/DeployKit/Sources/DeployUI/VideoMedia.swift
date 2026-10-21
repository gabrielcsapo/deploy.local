import SwiftUI
import AVKit
import DeployCore
import CoreTransferable
import UniformTypeIdentifiers

struct VideoPoster: View {
    let attachment: MediaAttachment
    let connection: Connection?
    let compact: Bool
    @State private var poster: CGImage?
    @State private var duration: Double?
    var body: some View {
        // The badge sits on the poster itself (fixed height at the video's own aspect ratio).
        Group {
            if let poster { Image(decorative: poster, scale: 1).resizable().aspectRatio(contentMode: .fit) }
            else { Rectangle().fill(.quaternary).aspectRatio(9 / 16, contentMode: .fit) }
        }
        .frame(height: compact ? WorkspaceStyle.mediaStripHeight : WorkspaceStyle.mediaThumbnailHeight)
        .overlay {
            Image(systemName: "play.fill").font(compact ? .caption : .title3).foregroundStyle(.white)
                .padding(compact ? 6 : 10).background(.black.opacity(0.45), in: Circle()).accessibilityHidden(true)
        }
        .overlay(alignment: .bottomTrailing) {
            if let text = formatMediaDuration(duration ?? attachment.duration) {
                Text(text).font(.caption2.monospacedDigit().weight(.semibold)).foregroundStyle(.white)
                    .lineLimit(1).fixedSize()
                    .padding(.horizontal, 5).padding(.vertical, 2).background(.black.opacity(0.55), in: Capsule()).padding(4)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: WorkspaceStyle.radius))
            .task(id: connection.flatMap { try? AuthenticatedImageCache.key(connection: $0, attachmentId: attachment.id) }) {
                poster = nil; duration = nil
                guard let connection, let asset = try? AuthenticatedMedia.asset(connection: connection, attachmentId: attachment.id) else { return }
                duration = try? await asset.load(.duration).seconds
                let generator = AVAssetImageGenerator(asset: asset)
                generator.appliesPreferredTrackTransform = true
                generator.maximumSize = CGSize(width: WorkspaceStyle.mediaThumbnailWidth * 2, height: WorkspaceStyle.mediaThumbnailHeight * 2)
                poster = try? await generator.image(at: CMTime(seconds: 0.1, preferredTimescale: 600)).image
            }
    }
}
struct PickedVideo: Transferable, Sendable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            // A unique folder keeps the original file name, which becomes the attachment's name.
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let file = folder.appendingPathComponent(received.file.lastPathComponent)
            try FileManager.default.copyItem(at: received.file, to: file)
            return PickedVideo(url: file)
        }
    }
}
struct AttachmentUploadProgress: View {
    @Bindable var store: WorkspaceStore
    var body: some View {
        if store.uploadingAttachment {
            HStack {
                ProgressView(value: store.attachmentUploadProgress)
                Text("\(store.attachmentUploadName ?? "Attachment"): \(Int(store.attachmentUploadProgress * 100))%")
                    .font(.caption)
                WorkspaceIconButton(label: "Cancel upload", icon: .close) { store.cancelAttachmentUpload() }
            }
        }
    }
}
