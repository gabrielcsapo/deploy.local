import Foundation
import CryptoKit

/// Cache identities include the authenticated account and credential, never the token in plaintext.
public actor AuthenticatedImageCache {
    public static let shared = AuthenticatedImageCache()
    private var memory: [String: Data] = [:]
    private let directory: URL
    private let session: URLSession
    public init(directory: URL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("deploy.local/media"),
                session: URLSession = URLSession(configuration: .ephemeral, delegate: OriginRedirectGuard(), delegateQueue: nil)) {
        self.directory = directory; self.session = session
    }
    public nonisolated static func key(connection: Connection, attachmentId: String) throws -> String {
        var origin = URLComponents(url: try connection.baseURL(), resolvingAgainstBaseURL: true)!
        origin.host = origin.host?.lowercased(); origin.path = ""
        if (origin.scheme == "https" && origin.port == 443) || (origin.scheme == "http" && origin.port == 80) { origin.port = nil }
        let identity = try JSONEncoder().encode([origin.string!, connection.username, connection.token, attachmentId])
        return SHA256.hash(data: identity).map { String(format: "%02x", $0) }.joined()
    }
    public func data(connection: Connection, attachmentId: String) async throws -> Data {
        guard !attachmentId.isEmpty, attachmentId.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" }) else { throw ClientError.invalidResponse }
        let key = try Self.key(connection: connection, attachmentId: attachmentId)
        if let data = memory[key] { return data }
        let file = directory.appendingPathComponent(key)
        if let cached = try? Data(contentsOf: file), cached.count <= 20 * 1024 * 1024 {
            remember(cached, key: key)
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
            return cached
        }
        let base = try connection.baseURL()
        let url = base.appendingPathComponent("api/attachments/\(attachmentId)")
        var request = URLRequest(url: url)
        request.setValue(connection.username, forHTTPHeaderField: "X-Deploy-Username")
        request.setValue(connection.token, forHTTPHeaderField: "X-Deploy-Token")
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        guard response.statusCode == 200 else { throw ClientError.response(response.statusCode, "Image unavailable") }
        guard data.count <= 20 * 1024 * 1024 else { throw ClientError.response(413, "Image exceeds 20 MB") }
        remember(data, key: key)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try data.write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        trimDisk()
        return data
    }
    private func remember(_ data: Data, key: String) {
        if memory.values.reduce(0, { $0 + $1.count }) + data.count > 40 * 1024 * 1024 { memory.removeAll() }
        memory[key] = data
    }
    private func trimDisk() {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey])) ?? []
        let entries = files.compactMap { url -> (URL, Int, Date)? in
            guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]) else { return nil }
            return (url, values.fileSize ?? 0, values.contentModificationDate ?? .distantPast)
        }.sorted { $0.2 < $1.2 }
        var total = entries.reduce(0) { $0 + $1.1 }
        for (url, size, _) in entries where total > 100 * 1024 * 1024 {
            try? FileManager.default.removeItem(at: url); total -= size
        }
    }
}

/// Read-time conversion of stored attachment strings only; never an HTTP alias.
/// Keep foreign, protocol-relative and embedded paths unchanged, as the server reader does.
public func convertStoredAttachmentText(_ text: String, origins: [String] = ["https://deploy.local"]) -> String {
    let pattern = #"(?:https?://[^\s<>"'`()]+)?/api/(?:v2|workspace)/attachments/[A-Za-z0-9-]+"#
    let regex = try! NSRegularExpression(pattern: pattern)
    let source = text as NSString
    var result = text
    for match in regex.matches(in: text, range: NSRange(location: 0, length: source.length)).reversed() {
        let link = source.substring(with: match.range)
        let absolute = link.hasPrefix("http://") || link.hasPrefix("https://")
        if absolute {
            guard let url = URL(string: link), origins.contains(where: { origin in
                guard let base = URL(string: origin) else { return false }
                return attachmentSameOrigin(url, base)
            }) else { continue }
        } else if match.range.location > 0 {
            let previous = source.substring(with: NSRange(location: match.range.location - 1, length: 1))
            if previous.range(of: #"[\w/.:%-]"#, options: .regularExpression) != nil { continue }
        }
        let converted = link.replacingOccurrences(of: "/api/v2/attachments/", with: "/api/conversation-attachments/")
            .replacingOccurrences(of: "/api/workspace/attachments/", with: "/api/attachments/")
        if let range = Range(match.range, in: result) { result.replaceSubrange(range, with: converted) }
    }
    return result
}

private func attachmentSameOrigin(_ url: URL, _ base: URL) -> Bool {
    func port(_ url: URL) -> Int? { url.port ?? (url.scheme == "https" ? 443 : url.scheme == "http" ? 80 : nil) }
    return url.scheme == base.scheme && url.host?.lowercased() == base.host?.lowercased() && port(url) == port(base)
        && url.user == nil && url.password == nil
}

/// Resolve only this coordinator's attachment URLs before adding credentials or opening media.
public func storedAttachmentURL(_ link: String, connection: Connection) -> URL? {
    guard let base = try? connection.baseURL(), !link.hasPrefix("//") else { return nil }
    let converted = convertStoredAttachmentText(link, origins: [base.absoluteString])
    guard let url = URL(string: converted, relativeTo: base)?.absoluteURL,
          attachmentSameOrigin(url, base),
          url.path.range(of: #"^/api/(?:conversation-attachments|attachments)/[A-Za-z0-9-]+(?:/thumbnail)?$"#, options: .regularExpression) != nil else { return nil }
    return url
}
