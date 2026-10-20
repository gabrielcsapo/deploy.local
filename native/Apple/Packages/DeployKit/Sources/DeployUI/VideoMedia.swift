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
        ZStack(alignment: .bottomTrailing) {
            Group {
                if let poster { Image(decorative: poster, scale: 1).resizable().scaledToFit() }
                else { Rectangle().fill(.quaternary).overlay(Image(systemName: "play.fill")) }
            }.frame(width: compact ? WorkspaceStyle.mediaStripWidth : WorkspaceStyle.mediaThumbnailWidth,
                    height: compact ? WorkspaceStyle.mediaStripHeight : WorkspaceStyle.mediaThumbnailHeight)
            Label(formatMediaDuration(duration ?? attachment.duration) ?? "Video", systemImage: "play.fill")
                .font(.caption).padding(WorkspaceStyle.space2).background(.regularMaterial)
        }.clipShape(RoundedRectangle(cornerRadius: WorkspaceStyle.radius))
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
            let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "-" + received.file.lastPathComponent)
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
                Button("Cancel upload") { store.cancelAttachmentUpload() }.buttonStyle(.workspaceLink)
            }
        }
    }
}
