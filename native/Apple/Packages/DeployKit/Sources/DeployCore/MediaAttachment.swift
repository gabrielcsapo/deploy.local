import Foundation

public struct MediaAttachment: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let taskId: String
    public let runId: String?
    public let messageId: String?
    public let kind: String
    public let mimeType: String
    public let size: Int
    public let width: Int?
    public let height: Int?
    public let duration: Double?
    public let name: String
    public let caption: String?
    public let source: String
    public let createdAt: String
    /// Text job artifacts: a short redacted preview stored by the coordinator.
    public var preview: String? = nil
    /// The job that returned this file, for job artifacts.
    public var jobId: String? = nil
    public var displayCaption: String { caption.flatMap { $0.isEmpty ? nil : $0 } ?? name }
    public var downloadName: String {
        guard ["image", "video"].contains(kind), URL(fileURLWithPath: name).pathExtension.isEmpty else { return name }
        let ext = mimeType == "video/quicktime" ? "mov" : (mimeType.split(separator: "/").last.map(String.init) ?? "png")
        return name + "." + ext
    }
}

