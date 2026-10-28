import Foundation
import Security
import CryptoKit

public struct V2PairingPayload: Codable, Equatable, Sendable {
    public let version: Int
    public let address: String
    public let fingerprint: String
    public let token: String
    public let expiresAt: Double
    public static func parse(_ text: String, now: Date = Date()) throws -> Self {
        guard text.utf8.count <= 8192, let data = text.data(using: .utf8),
              let payload = try? JSONDecoder().decode(Self.self, from: data) else { throw ClientError.response(400, "Scan the code in Settings › Devices on your computer.") }
        guard payload.version == 1 else { throw ClientError.response(400, "This pairing code needs a newer iPhone app.") }
        let url = try Connection(origin: payload.address, username: "", token: "").baseURL()
        guard url.scheme == "https", payload.token.count >= 32, payload.token.count <= 512,
              payload.fingerprint.range(of: "^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$", options: .regularExpression) != nil else { throw ClientError.response(400, "The pairing code is incomplete.") }
        guard payload.expiresAt > now.timeIntervalSince1970 * 1000 else { throw ClientError.response(410, "This code expired. Create a new code on your computer.") }
        return payload
    }
}
public struct V2PairedDevice: Codable, Equatable, Sendable {
    public let id: String
    public let connection: Connection
    public let fingerprint: String
    public let certificate: Data
    public let expiresAt: Double
}
public enum V2PairingVault {
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "local.deploy.v2.pairing", kSecAttrAccount as String: "coordinator"]
    }
    public static func load() -> V2PairedDevice? {
        var request = query
        request[kSecReturnData as String] = true; request[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &value) == errSecSuccess, let data = value as? Data else { return nil }
        return try? JSONDecoder().decode(V2PairedDevice.self, from: data)
    }
    public static func save(_ device: V2PairedDevice) throws {
        let data = try JSONEncoder().encode(device)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var request = query
            request[kSecValueData as String] = data
            request[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(request as CFDictionary, nil) == errSecSuccess else { throw ClientError.response(500, "Could not save the paired device in Keychain.") }
        } else if status != errSecSuccess { throw ClientError.response(500, "Could not update the paired device in Keychain.") }
    }
    public static func clear() { SecItemDelete(query as CFDictionary) }
    public static func session(for connection: Connection) -> URLSession? {
        guard URL(string: connection.origin)?.scheme == "https", let device = load(), device.connection == connection else { return nil }
        return URLSession(configuration: .ephemeral, delegate: V2PinnedCoordinator(origin: connection.origin, fingerprint: device.fingerprint, certificate: device.certificate), delegateQueue: nil)
    }
}

// The QR is the trust source. Never accept a redirect or a separately fetched fingerprint.
public final class V2PinnedCoordinator: NSObject, URLSessionDelegate, URLSessionTaskDelegate, Sendable {
    private let origin: String
    private let fingerprint: String
    private let certificate: Data
    public init(origin: String, fingerprint: String, certificate: Data) { self.origin = origin; self.fingerprint = fingerprint.uppercased(); self.certificate = certificate }
    public static func matches(certificate: Data, fingerprint: String) -> Bool {
        SHA256.hash(data: certificate).map { String(format: "%02X", $0) }.joined(separator: ":") == fingerprint.uppercased()
    }
    public func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let url = URL(string: origin), challenge.protectionSpace.host.lowercased() == url.host?.lowercased(),
              challenge.protectionSpace.port == (url.port ?? 443),
              let trust = challenge.protectionSpace.serverTrust else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        // The downloaded root is authenticated by the QR before any token is sent.
        SecTrustSetNetworkFetchAllowed(trust, false)
        guard Self.matches(certificate: certificate, fingerprint: fingerprint),
              let root = SecCertificateCreateWithData(nil, certificate as CFData),
              SecTrustSetAnchorCertificates(trust, [root] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
              SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, url.host! as CFString)) == errSecSuccess,
              SecTrustEvaluateWithError(trust, nil) else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
public enum V2PairingClient {
    public static func certificateDER(_ data: Data, fingerprint: String) throws -> Data {
        guard data.count <= 65536 else { throw ClientError.invalidResponse }
        let der: Data
        if let pem = String(data: data, encoding: .utf8), pem.contains("-----BEGIN CERTIFICATE-----") {
            let base64 = pem.replacingOccurrences(of: "-----BEGIN CERTIFICATE-----", with: "").replacingOccurrences(of: "-----END CERTIFICATE-----", with: "").components(separatedBy: .whitespacesAndNewlines).joined()
            guard let decoded = Data(base64Encoded: base64) else { throw ClientError.invalidResponse }
            der = decoded
        } else { der = data }
        guard V2PinnedCoordinator.matches(certificate: der, fingerprint: fingerprint), SecCertificateCreateWithData(nil, der as CFData) != nil else { throw ClientError.response(400, "The coordinator certificate does not match this code. Create a new code on your computer.") }
        return der
    }
    private static func downloadCertificate(_ payload: V2PairingPayload, session: URLSession?) async throws -> Data {
        // TLS servers need not send their root. Fetch only its public bytes without credentials,
        // authenticate them against the scanned digest, then create a separate pinned session.
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        let transport = session ?? URLSession(configuration: config, delegate: V2PublicCertificateDownload(origin: payload.address), delegateQueue: nil)
        defer { if session == nil { transport.invalidateAndCancel() } }
        let base = try Connection(origin: payload.address, username: "", token: "").baseURL()
        var request = URLRequest(url: URL(string: "/ca.crt", relativeTo: base)!.absoluteURL)
        request.timeoutInterval = 20; request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await transport.data(for: request)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200 else { throw ClientError.response(400, "The coordinator certificate is unavailable. Sign in with a password or create a new pairing code.") }
        return try certificateDER(data, fingerprint: payload.fingerprint)
    }
    public static func exchange(_ payload: V2PairingPayload, name: String, session: URLSession? = nil) async throws -> V2PairedDevice {
        _ = try V2PairingPayload.parse(String(decoding: JSONEncoder().encode(payload), as: UTF8.self))
        let certificate = try await downloadCertificate(payload, session: session)
        let transport = session ?? URLSession(configuration: .ephemeral, delegate: V2PinnedCoordinator(origin: payload.address, fingerprint: payload.fingerprint, certificate: certificate), delegateQueue: nil)
        let client = WorkspaceClient(connection: Connection(origin: payload.address, username: "", token: ""), session: transport)
        struct Response: Decodable, Sendable { let id: String; let username: String; let token: String; let expiresAt: Double }
        do {
            let result: Response = try await client.request("/api/v2/devices/exchange", method: "POST", body: JSONEncoder().encode(["token": payload.token, "name": name]))
            guard !result.id.isEmpty, !result.username.isEmpty, !result.token.isEmpty, result.expiresAt > Date().timeIntervalSince1970 * 1000 else { throw ClientError.invalidResponse }
            return V2PairedDevice(id: result.id, connection: Connection(origin: payload.address, username: result.username, token: result.token), fingerprint: payload.fingerprint, certificate: certificate, expiresAt: result.expiresAt)
        } catch ClientError.response(let status, _) where status == 404 || status == 501 {
            throw ClientError.response(status, "This coordinator does not support iPhone pairing yet. Sign in with a password.")
        }
    }
}

// This delegate is private to the credential-free /ca.crt download. The downloaded
// bytes are untrusted until their DER hash matches the fingerprint scanned from QR.
private final class V2PublicCertificateDownload: NSObject, URLSessionDelegate, URLSessionTaskDelegate, Sendable {
    let origin: String
    init(origin: String) { self.origin = origin }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard let url = URL(string: origin), challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host.lowercased() == url.host?.lowercased(), challenge.protectionSpace.port == (url.port ?? 443),
              let trust = challenge.protectionSpace.serverTrust else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
