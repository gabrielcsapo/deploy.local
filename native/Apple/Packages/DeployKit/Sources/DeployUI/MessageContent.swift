import SwiftUI
import MarkdownUI
import DeployCore
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Links into the task workspace open the Changes view instead of the system.
struct MessageFileLinks {
    let taskId: String
    let workspacePaths: [String?]
    let open: (TaskFileReference) -> Void
}

/// A native GFM document, isolated from polling-driven transcript updates by Equatable.
struct MessageContent: View, Equatable {
    let content: String
    var fileLinks: MessageFileLinks? = nil
    #if os(iOS)
    @ScaledMetric(relativeTo: .body) private var textSize = 17.0
    #else
    private let textSize = 15.0
    #endif
    @Environment(\.taskMedia) private var media
    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.content == rhs.content && lhs.fileLinks?.taskId == rhs.fileLinks?.taskId
            && lhs.fileLinks?.workspacePaths == rhs.fileLinks?.workspacePaths
    }
    private var attachments: [MessageAttachmentRef] {
        media.map { MessageAttachmentRef(id: $0.id, name: $0.name, kind: $0.kind) }
    }

    var body: some View {
        // Worker-disk paths become in-task links, attachments or inline code before MarkdownUI sees them.
        Markdown(rewriteLocalFileLinks(content, taskId: fileLinks?.taskId,
                                       workspacePaths: fileLinks?.workspacePaths ?? [], attachments: attachments))
            .markdownTextStyle(\.text) {
                ForegroundColor(.primary)
                BackgroundColor(nil)
                FontSize(textSize)
            }
            .markdownTextStyle(\.code) {
                FontFamilyVariant(.monospaced)
                FontSize(.em(0.88))
                BackgroundColor(.primary.opacity(0.055))
            }
            .markdownBlockStyle(\.heading1) { configuration in
                configuration.label.markdownTextStyle { FontSize(.em(1.6)); FontWeight(.semibold) }
                    .markdownMargin(top: 22, bottom: 12)
            }
            .markdownBlockStyle(\.heading2) { configuration in
                configuration.label.markdownTextStyle { FontSize(.em(1.33)); FontWeight(.semibold) }
                    .markdownMargin(top: 20, bottom: 10)
            }
            .markdownBlockStyle(\.heading3) { configuration in
                configuration.label.markdownTextStyle { FontSize(.em(1.13)); FontWeight(.semibold) }
                    .markdownMargin(top: 18, bottom: 8)
            }
            .markdownBlockStyle(\.codeBlock) { configuration in
                ConversationCodeBlock(configuration: configuration).markdownMargin(top: 12, bottom: 16)
            }
            .markdownBlockStyle(\.table) { configuration in
                ScrollView(.horizontal) {
                    configuration.label
                        .markdownTableBorderStyle(.init(color: .primary.opacity(0.1)))
                        .markdownTableBackgroundStyle(.alternatingRows(.clear, .primary.opacity(0.025)))
                        .markdownTextStyle { FontSize(.em(0.93)) }
                        .textSelection(.enabled)
                }
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .markdownMargin(top: 12, bottom: 16)
            }
            .markdownTheme(.gitHub)
            .markdownImageProvider(ConversationImageProvider())
            .textSelection(.enabled)
            .environment(\.openURL, OpenURLAction { url in
                if ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") { return .systemAction }
                if let fileLinks, let reference = TaskFileReference(linkURL: url) {
                    fileLinks.open(reference)
                    return .handled
                }
                if let fileLinks, let reference = taskFileReference(url.absoluteString, taskId: fileLinks.taskId,
                                                                     workspacePaths: fileLinks.workspacePaths) {
                    fileLinks.open(reference)
                    return .handled
                }
                return .discarded
            })
    }
}

private struct ConversationCodeBlock: View {
    let configuration: CodeBlockConfiguration
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(configuration.language ?? "Code").foregroundStyle(.secondary)
                Spacer()
                WorkspaceCopyButton(label: "Copy code", text: configuration.content)
            }.font(.caption).padding(.horizontal, 14).padding(.vertical, 10)
            Divider().opacity(0.5)
            ScrollView(.horizontal) {
                configuration.label
                    .markdownTextStyle { FontFamilyVariant(.monospaced); FontSize(.em(0.87)); BackgroundColor(nil) }
                    .relativeLineSpacing(.em(0.25)).textSelection(.enabled).padding(16)
            }
        }.background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(.primary.opacity(0.08), lineWidth: 0.5))
    }
}

private struct ConversationImageProvider: ImageProvider {
    func makeImage(url: URL?) -> some View {
        if let url, url.path.hasPrefix("/api/workspace/attachments/"), !url.path.hasSuffix("/thumbnail") {
            AttachmentThumbnail(id: url.lastPathComponent)
        } else if let url, ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
            AsyncImage(url: url) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFit().frame(maxHeight: 420).clipShape(RoundedRectangle(cornerRadius: 10))
                } else if phase.error != nil {
                    Label("Image unavailable", systemImage: "photo").foregroundStyle(.secondary)
                } else { ProgressView().padding() }
            }
        } else { Label("Image unavailable", systemImage: "photo").foregroundStyle(.secondary) }
    }
}
