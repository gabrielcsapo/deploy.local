#if os(iOS)
import SwiftUI
import WebKit
import DeployCore

/// A project's Design page, full screen: the web canvas, signed in as you. iPad gets the desktop
/// layout and draws with Apple Pencil through the pen tool; iPhone gets the phone layout.
struct V2DesignView: View {
    let connection: Connection
    let projectId: String
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        V2DesignWebView(connection: connection, projectId: projectId, leave: { dismiss() })
            .ignoresSafeArea(.container, edges: .bottom)
            .background(WorkspaceStyle.canvas(scheme).ignoresSafeArea())
    }
}

struct V2DesignWebView: UIViewRepresentable {
    let connection: Connection
    let projectId: String
    let leave: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(connection: connection, leave: leave) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        // The page reads who you are from local storage and its requests carry the session cookie;
        // both come from the app's own sign-in, so the page never asks again.
        let auth = (try? JSONSerialization.data(withJSONObject: ["username": connection.username, "token": connection.token]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "null"
        configuration.userContentController.addUserScript(WKUserScript(
            source: "try { localStorage.setItem('deploy-sh-auth', JSON.stringify(\(auth))) } catch (error) {}",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.allowsBackForwardNavigationGestures = false
        context.coordinator.watch(view)
        guard let url = Self.address(connection.origin, projectId), let host = url.host else { return view }
        var cookie: [HTTPCookiePropertyKey: Any] = [
            .domain: host, .path: "/", .name: "deploy-sh-auth",
            .value: "\(connection.username):\(connection.token)".addingPercentEncoding(withAllowedCharacters: Self.cookieSafe) ?? "",
            .expires: Date().addingTimeInterval(30 * 24 * 3600),
        ]
        if url.scheme == "https" { cookie[.secure] = "TRUE" }
        if let value = HTTPCookie(properties: cookie) {
            configuration.websiteDataStore.httpCookieStore.setCookie(value) { view.load(URLRequest(url: url)) }
        } else { view.load(URLRequest(url: url)) }
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    /// The Design page for a project on the coordinator.
    static func address(_ origin: String, _ projectId: String) -> URL? {
        var parts = URLComponents(string: origin)
        parts?.path = "/dashboard/design"
        parts?.queryItems = [URLQueryItem(name: "project", value: projectId)]
        return parts?.url
    }
    /// What encodeURIComponent leaves alone, as the server's own cookie writes it.
    static let cookieSafe = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.!~*'()"))

    final class Coordinator: NSObject, WKNavigationDelegate {
        let connection: Connection
        let leave: () -> Void
        private var address: NSKeyValueObservation?
        init(connection: Connection, leave: @escaping () -> Void) { self.connection = connection; self.leave = leave }

        /// The page moves between places without loading a new document; leaving the Design page
        /// (its back button) closes it and returns to the project.
        func watch(_ view: WKWebView) {
            address = view.observe(\.url, options: [.new]) { [weak self] view, _ in
                guard let url = view.url, url.scheme != "about" else { return }
                if !url.path.hasPrefix("/dashboard/design") { DispatchQueue.main.async { self?.leave() } }
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            guard action.targetFrame?.isMainFrame ?? false, let url = action.request.url else { return decisionHandler(.allow) }
            let home = URL(string: connection.origin)
            if url.host == home?.host, url.path.hasPrefix("/dashboard/design") { return decisionHandler(.allow) }
            decisionHandler(.cancel)
            leave()
        }

        func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping @MainActor (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            // A paired coordinator is trusted the way the pairing code said; everything else, like fonts, as usual.
            guard challenge.protectionSpace.host.lowercased() == URL(string: connection.origin)?.host?.lowercased(),
                  let pinned = V2PairingVault.pinned(for: connection) else { return completionHandler(.performDefaultHandling, nil) }
            let (disposition, credential) = pinned.evaluate(challenge)
            completionHandler(disposition, credential)
        }
    }
}
#endif
