import Foundation
import AVFoundation

public func formatMediaDuration(_ seconds: Double?) -> String? {
    guard let seconds, seconds.isFinite, seconds >= 0, seconds < Double(Int.max) else { return nil }
    let total = Int(seconds.rounded(.down))
    return String(format: "%d:%02d", total / 60, total % 60)
}
public enum AuthenticatedMedia {
    public static func request(connection: Connection, attachmentId: String) throws -> URLRequest {
        guard !attachmentId.isEmpty, attachmentId.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" }) else { throw ClientError.invalidResponse }
        var request = URLRequest(url: try connection.baseURL().appendingPathComponent("api/attachments/\(attachmentId)"))
        request.setValue(connection.username, forHTTPHeaderField: "X-Deploy-Username")
        request.setValue(connection.token, forHTTPHeaderField: "X-Deploy-Token")
        return request
    }
    public static func asset(connection: Connection, attachmentId: String) throws -> AVURLAsset {
        let request = try request(connection: connection, attachmentId: attachmentId)
        return AVURLAsset(url: request.url!, options: ["AVURLAssetHTTPHeaderFieldsKey": request.allHTTPHeaderFields ?? [:]])
    }
    public static func download(connection: Connection, attachment: MediaAttachment) async throws -> URL {
        let session = URLSession(configuration: .ephemeral, delegate: OriginRedirectGuard(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let (temporary, response) = try await session.download(for: request(connection: connection, attachmentId: attachment.id))
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw ClientError.invalidResponse }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "-" + attachment.downloadName)
        try FileManager.default.moveItem(at: temporary, to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        return file
    }
}
private final class MediaUploadDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    let progress: @Sendable (Double) -> Void
    init(progress: @escaping @Sendable (Double) -> Void) { self.progress = progress }
    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        if totalBytesExpectedToSend > 0 { progress(min(1, Double(totalBytesSent) / Double(totalBytesExpectedToSend))) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
extension WorkspaceStore {
    public func cancelAttachmentUpload() { mediaUploadTask?.cancel() }
    public func addAttachment(file: URL, name: String? = nil) async {
        guard let connection, let taskId = selectedTaskId else { return }
        while uploadingAttachment {
            do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
            guard self.connection == connection, selectedTaskId == taskId else { return }
        }
        guard pendingAttachments.count < 20 else { error = "Use at most 20 attachments."; return }
        uploadingAttachment = true; attachmentUploadProgress = 0; attachmentUploadName = name ?? file.lastPathComponent
        defer { uploadingAttachment = false; mediaUploadTask = nil; attachmentUploadName = nil }
        let task = Task { [self] () throws -> MediaAttachment in
            var parts = URLComponents(); parts.queryItems = [URLQueryItem(name: "name", value: name ?? file.lastPathComponent), URLQueryItem(name: "operationId", value: UUID().uuidString)]
            var request = URLRequest(url: try connection.baseURL().appendingPathComponent("api/tasks/\(taskId)/attachments"))
            request.url = URL(string: request.url!.absoluteString + "?" + parts.percentEncodedQuery!)
            request.httpMethod = "POST"; request.timeoutInterval = 600
            request.setValue(connection.username, forHTTPHeaderField: "X-Deploy-Username")
            request.setValue(connection.token, forHTTPHeaderField: "X-Deploy-Token")
            request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            let delegate = MediaUploadDelegate { [weak self] progress in Task { @MainActor in self?.attachmentUploadProgress = progress } }
            let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
            defer { session.finishTasksAndInvalidate() }
            let (data, response) = try await session.upload(for: request, fromFile: file)
            guard let response = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
            guard response.statusCode == 200 else {
                let message = (try? JSONSerialization.jsonObject(with: data) as? [String: String])?["error"] ?? "Upload failed"
                throw ClientError.response(response.statusCode, message)
            }
            return try JSONDecoder().decode(MediaAttachment.self, from: data)
        }
        mediaUploadTask = task
        do {
            let attachment = try await task.value
            guard self.connection == connection else { return }
            if selectedTaskId == taskId { pendingAttachments.append(attachment); saveDraft() }
            else {
                saveUploadedAttachment(attachment, taskId: taskId)
            }
        } catch { self.error = task.isCancelled ? "Upload cancelled" : error.localizedDescription }
    }
}
