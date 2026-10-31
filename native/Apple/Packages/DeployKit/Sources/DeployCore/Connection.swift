import Foundation
import Security

public struct Connection: Codable, Equatable, Hashable, Sendable {
    public var origin: String
    public var username: String
    public var token: String

    public init(origin: String, username: String, token: String) {
        self.origin = origin.trimmingCharacters(in: .whitespacesAndNewlines)
        self.username = username
        self.token = token
    }

    public func baseURL() throws -> URL {
        guard let url = URL(string: origin), let host = url.host,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { throw ClientError.invalidOrigin }
        let loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
        guard url.scheme == "https" || (url.scheme == "http" && loopback) else {
            throw ClientError.invalidOrigin
        }
        return url
    }
}

public enum ClientError: Error, LocalizedError, Sendable {
    case invalidOrigin
    case response(Int, String)
    case invalidResponse
    public var errorDescription: String? {
        switch self {
        case .invalidOrigin: "Use an HTTPS coordinator address, or HTTP localhost for development."
        case .response(let status, let message): "\(message) (\(status))"
        case .invalidResponse: "The coordinator returned an unreadable response."
        }
    }
}

public func coordinatorErrorDescription(_ error: Error) -> String {
    if case ClientError.response(401, _) = error {
        return "Your session has expired. Sign in again to continue. Your conversation and draft are preserved."
    }
    guard let network = error as? URLError else { return error.localizedDescription }
    switch network.code {
    case .notConnectedToInternet, .cannotConnectToHost, .cannotFindHost, .timedOut:
        #if os(iOS)
        return "Cannot reach your home coordinator. Check that this iPhone is on your home Wi-Fi and that deploy.local is enabled in Settings → Privacy & Security → Local Network. Also check the coordinator address and port."
        #else
        return "Cannot reach your home coordinator. Check the network connection, coordinator address and port, and Local Network access in System Settings."
        #endif
    default: return error.localizedDescription
    }
}

public enum CredentialVault {
    private static let service = "local.deploy.workspace"
    private static var query: [String: Any] {
        var attributes: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: "coordinator"]
        #if os(macOS)
        // Use the signed app's private access group, rather than the legacy file-based
        // Keychain ACL tied to earlier development executables. Never loosen old ACLs.
        attributes[kSecUseDataProtectionKeychain as String] = true
        attributes[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail
        #endif
        return attributes
    }

    public static func load() -> Connection? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(Connection.self, from: data)
    }

    public static func save(_ connection: Connection) throws {
        let data = try JSONEncoder().encode(connection)
        let attributes: [String: Any] = [kSecValueData as String: data]
        let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updated == errSecItemNotFound {
            var request = query
            request[kSecValueData as String] = data
            request[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let added = SecItemAdd(request as CFDictionary, nil)
            guard added == errSecSuccess else { throw ClientError.response(Int(added), "Unable to save login in Keychain") }
        } else if updated != errSecSuccess {
            throw ClientError.response(Int(updated), "Unable to update login in Keychain")
        }
    }

    public static func clear() { SecItemDelete(query as CFDictionary) }

    /// Why a login could not be kept, in terms a person can act on, and whether retrying can help.
    public static func saveFailure(_ error: Error) -> (message: String, retryable: Bool) {
        guard case ClientError.response(let status, _) = error else {
            return ("You’re signed in, but your login wasn’t saved. You’ll need to sign in again after quitting.", true)
        }
        switch OSStatus(status) {
        case errSecMissingEntitlement:
            // Ad hoc and unsigned development builds have no private Keychain access group.
            return ("You’re signed in, but this copy of deploy.local isn’t code signed, so macOS won’t let it save your login. Install a signed build to stay signed in after quitting.", false)
        case errSecInteractionNotAllowed, errSecNotAvailable:
            return ("You’re signed in, but the Keychain is locked or unavailable, so your login wasn’t saved. Unlock your Mac’s login Keychain and try again.", true)
        default:
            return ("You’re signed in, but the Keychain didn’t save your login (error \(status)). Try again, or sign in again after quitting.", true)
        }
    }
}

public actor WorkspaceClient {
    public let connection: Connection
    private let session: URLSession

    public init(connection: Connection, session: URLSession = URLSession(configuration: .ephemeral, delegate: OriginRedirectGuard(), delegateQueue: nil)) {
        self.connection = connection
        self.session = session
    }

    public func request<T: Decodable & Sendable>(_ path: String, method: String = "GET", body: Data? = nil, contentType: String = "application/json", timeout: TimeInterval = 20) async throws -> T {
        try JSONDecoder().decode(T.self, from: await data(path, method: method, body: body, contentType: contentType, timeout: timeout))
    }

    /// The response's bytes, for what is not JSON, like a rendered board.
    public func data(_ path: String, method: String = "GET", body: Data? = nil, contentType: String = "application/json", timeout: TimeInterval = 20) async throws -> Data {
        let base = try connection.baseURL()
        guard let url = URL(string: path, relativeTo: base)?.absoluteURL,
              url.host == base.host, url.port == base.port, url.scheme == base.scheme else {
            throw ClientError.invalidOrigin
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue(connection.username, forHTTPHeaderField: "X-Deploy-Username")
        request.setValue(connection.token, forHTTPHeaderField: "X-Deploy-Token")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        guard (200..<300).contains(response.statusCode) else {
            let payload = try? JSONDecoder().decode(APIError.self, from: data)
            throw ClientError.response(response.statusCode, payload?.error ?? "Request failed")
        }
        return data
    }

    public static func login(origin: String, username: String, password: String) async throws -> Connection {
        let connection = Connection(origin: origin, username: username, token: "")
        let client = WorkspaceClient(connection: connection)
        let body = try JSONEncoder().encode(LoginBody(username: username, password: password))
        let result: LoginResult = try await client.request("/api/login", method: "POST", body: body)
        return Connection(origin: origin, username: username, token: result.token)
    }
}

private struct APIError: Decodable { let error: String }
private struct LoginBody: Encodable { let username: String; let password: String }
private struct LoginResult: Decodable, Sendable { let token: String }

/// Never forward coordinator credentials to a redirected host or a downgraded transport.
public final class OriginRedirectGuard: NSObject, URLSessionTaskDelegate, Sendable {
    public func urlSession(_ session: URLSession, task: URLSessionTask,
                           willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest,
                           completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        guard let original = task.originalRequest?.url, let next = request.url,
              original.scheme == next.scheme, original.host == next.host, original.port == next.port else {
            completionHandler(nil); return
        }
        completionHandler(request)
    }
}
