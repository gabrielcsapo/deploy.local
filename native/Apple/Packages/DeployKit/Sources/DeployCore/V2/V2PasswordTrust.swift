import Foundation
import Security
import CryptoKit

public enum V2CertificateFingerprint {
    public static func full(_ certificate: Data) -> String {
        SHA256.hash(data: certificate).map { String(format: "%02X", $0) }.joined(separator: ":")
    }
    public static func short(_ fingerprint: String) -> String {
        let bytes = fingerprint.uppercased().split(separator: ":")
        guard bytes.count == 32, bytes.allSatisfy({ $0.count == 2 && UInt8($0, radix: 16) != nil }) else { return "" }
        return bytes.prefix(6).joined(separator: ":") + " · " + bytes.suffix(6).joined(separator: ":")
    }
}

public struct V2CheckedCertificate: Codable, Equatable, Sendable {
    public let origin: String
    public let certificate: Data
    public let fingerprint: String
    public let checkedAt: Date
    public var pinned: V2PinnedCoordinator { V2PinnedCoordinator(origin: origin, fingerprint: fingerprint, certificate: certificate) }
}
public enum V2CertificateVault {
    public static func origin(_ address: String) throws -> String {
        let url = try Connection(origin: address, username: "", token: "").baseURL()
        guard url.scheme == "https" else { throw ClientError.invalidOrigin }
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        parts.host = parts.host?.lowercased(); parts.path = ""
        if parts.port == 443 { parts.port = nil }
        return parts.string!
    }
    private static func query(_ origin: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "local.deploy.v2.certificate", kSecAttrAccount as String: origin]
    }
    public static func load(origin address: String) -> V2CheckedCertificate? {
        guard let origin = try? origin(address) else { return nil }
        var request = query(origin)
        request[kSecReturnData as String] = true; request[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &value) == errSecSuccess, let data = value as? Data,
              let record = try? JSONDecoder().decode(V2CheckedCertificate.self, from: data), record.origin == origin,
              V2PinnedCoordinator.matches(certificate: record.certificate, fingerprint: record.fingerprint) else { return nil }
        return record
    }
    public static func save(_ certificate: V2CheckedCertificate) throws {
        let origin = try origin(certificate.origin)
        guard origin == certificate.origin, V2PinnedCoordinator.matches(certificate: certificate.certificate, fingerprint: certificate.fingerprint) else { throw ClientError.invalidResponse }
        let data = try JSONEncoder().encode(certificate)
        let status = SecItemUpdate(query(origin) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var request = query(origin)
            request[kSecValueData as String] = data
            request[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(request as CFDictionary, nil) == errSecSuccess else { throw ClientError.response(500, "Could not save SER's certificate in Keychain.") }
        } else if status != errSecSuccess { throw ClientError.response(500, "Could not update SER's certificate in Keychain.") }
    }
    public static func clear(origin address: String) throws {
        let status = SecItemDelete(query(try origin(address)) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw ClientError.response(500, "Could not forget SER's certificate in Keychain.") }
    }
}

public enum V2CoordinatorTrust {
    public static func pinned(for connection: Connection) -> V2PinnedCoordinator? {
        V2PairingVault.pinned(for: connection) ?? V2CertificateVault.load(origin: connection.origin)?.pinned
    }
    public static func session(for connection: Connection) -> URLSession? {
        guard let pinned = pinned(for: connection) else { return nil }
        return URLSession(configuration: .ephemeral, delegate: pinned, delegateQueue: nil)
    }
    public static func checked(for connection: Connection) -> V2CheckedCertificate? {
        guard V2PairingVault.pinned(for: connection) == nil else { return nil }
        return V2CertificateVault.load(origin: connection.origin)
    }
}

public enum V2PasswordTrust {
    public static func accept(_ candidate: V2CheckedCertificate) throws {
        try V2CertificateVault.save(V2CheckedCertificate(origin: candidate.origin, certificate: candidate.certificate, fingerprint: candidate.fingerprint, checkedAt: Date()))
    }
    /// Returns a candidate only after its CA validates the server for this host. No login is sent here.
    public static func prepare(origin address: String) async throws -> V2CheckedCertificate? {
        let origin = try V2CertificateVault.origin(address)
        return try await prepare(origin: origin, saved: V2CertificateVault.load(origin: origin), probe: { origin, pinned in
            try await probe(origin: origin, delegate: (pinned as (any URLSessionDelegate)?) ?? V2SystemCertificateProbe())
        }, download: { try await V2PairingClient.downloadCertificate(origin: $0) })
    }
    static func prepare(origin: String, saved: V2CheckedCertificate?, probe: @Sendable (String, V2PinnedCoordinator?) async throws -> Void, download: @Sendable (String) async throws -> Data) async throws -> V2CheckedCertificate? {
        if let saved {
            try await probe(origin, saved.pinned)
            return nil
        }
        do {
            try await probe(origin, nil)
            return nil
        } catch {
            guard isTrustFailure(error) else { throw error }
        }
        let data = try await download(origin)
        let certificate = try certificateDER(data)
        let candidate = V2CheckedCertificate(origin: origin, certificate: certificate, fingerprint: V2CertificateFingerprint.full(certificate), checkedAt: Date())
        try await probe(origin, candidate.pinned)
        return candidate
    }
    static func isTrustFailure(_ error: Error) -> Bool {
        guard let error = error as? URLError else { return false }
        return [.serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid].contains(error.code)
    }
    private static func probe(origin: String, delegate: any URLSessionDelegate) async throws {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false; config.urlCredentialStorage = nil
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: URL(string: origin + "/ca.crt")!)
        request.httpMethod = "HEAD"; request.timeoutInterval = 20; request.cachePolicy = .reloadIgnoringLocalCacheData
        let (_, response) = try await session.data(for: request)
        // Any HTTP status proves TLS completed; redirects are never followed.
        guard response is HTTPURLResponse else { throw ClientError.invalidResponse }
    }
    public static func certificateDER(_ data: Data) throws -> Data {
        let der = try V2PairingClient.certificateBytes(data)
        guard SecCertificateCreateWithData(nil, der as CFData) != nil, isCA(der) else {
            throw ClientError.response(400, "SER did not provide a CA certificate.")
        }
        return der
    }
    // Security parses X.509 on iPhone but does not expose certificate extensions there.
    // Read Basic Constraints (2.5.29.19) from TBSCertificate's explicit extensions field.
    private static func isCA(_ data: Data) -> Bool {
        var certificate = DERReader(bytes: Array(data))
        guard let sequence = certificate.read(0x30), certificate.isEmpty else { return false }
        var fields = DERReader(bytes: sequence)
        guard let tbs = fields.read(0x30) else { return false }
        var body = DERReader(bytes: tbs)
        while !body.isEmpty {
            guard let field = body.read() else { return false }
            if field.tag != 0xA3 { continue }
            var explicit = DERReader(bytes: field.bytes)
            guard let extensions = explicit.read(0x30), explicit.isEmpty else { return false }
            var list = DERReader(bytes: extensions)
            while !list.isEmpty {
                guard let entry = list.read(0x30) else { return false }
                var item = DERReader(bytes: entry)
                guard let oid = item.read(0x06) else { return false }
                if oid != [0x55, 0x1D, 0x13] { continue }
                if item.peek == 0x01 { guard item.read(0x01) != nil else { return false } }
                guard let value = item.read(0x04), item.isEmpty else { return false }
                var octets = DERReader(bytes: value)
                guard let constraints = octets.read(0x30), octets.isEmpty else { return false }
                var basic = DERReader(bytes: constraints)
                return basic.read(0x01) == [0xFF]
            }
        }
        return false
    }
}
private struct DERReader {
    let bytes: [UInt8]
    var index = 0
    var isEmpty: Bool { index == bytes.count }
    var peek: UInt8? { index < bytes.count ? bytes[index] : nil }
    mutating func read(_ tag: UInt8) -> [UInt8]? {
        guard let field = read(), field.tag == tag else { return nil }
        return field.bytes
    }
    mutating func read() -> (tag: UInt8, bytes: [UInt8])? {
        guard index + 2 <= bytes.count else { return nil }
        let tag = bytes[index]; var length = Int(bytes[index + 1]); index += 2
        if length >= 128 {
            let count = length & 0x7F
            guard count > 0, count <= 3, index + count <= bytes.count else { return nil }
            length = 0
            for _ in 0..<count { length = length * 256 + Int(bytes[index]); index += 1 }
        }
        guard length <= bytes.count - index else { return nil }
        let value = Array(bytes[index..<(index + length)]); index += length
        return (tag, value)
    }
}
private final class V2SystemCertificateProbe: NSObject, URLSessionDelegate, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        completionHandler(challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust ? .performDefaultHandling : .cancelAuthenticationChallenge, nil)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
