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
    @Environment(\.horizontalSizeClass) private var width
    var body: some View {
        // Full screen on iPad reaches the bottom edge; on iPhone the page ends at the tab bar.
        V2DesignWebView(connection: connection, projectId: projectId, leave: { dismiss() })
            .ignoresSafeArea(.container, edges: width == .compact ? [] : .bottom)
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

#if os(iOS)
/// The project-scoped Design entry. Empty queues keep the same project's canvas.
struct V2DesignLanding: View {
    @Bindable var store: V2Store
    let projectId: String?
    @State private var proposals: [V2ReviewSummary]?
    @State private var projects: [V2DesignProject] = []
    @State private var selected: InboxItem?
    @State private var canvas: String?
    @State private var error: String?
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Group {
            if proposals?.isEmpty == true, let projectId {
                V2DesignView(connection: store.connection, projectId: projectId).toolbar(.hidden, for: .navigationBar)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        Text("To review").font(.largeTitle.bold())
                        V2Group(title: "Waiting on you") {
                            if let proposals {
                                ForEach(proposals) { proposal in
                                    Button { Task { await open(proposal) } } label: {
                                        HStack(spacing: 12) {
                                            VStack(alignment: .leading, spacing: 6) {
                                                Text(proposal.title).font(.body).foregroundStyle(WorkspaceStyle.text(scheme)).fixedSize(horizontal: false, vertical: true)
                                                Text("\(proposal.proposer.name) · \(V2ReviewModel.age(proposal.createdAt))").font(.footnote).foregroundStyle(.secondary)
                                                Text(proposal.stale ? V2ReviewModel.conflictCount(proposal.conflicts) : proposal.counts.label(includeRemoved: false))
                                                    .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                                            }.frame(maxWidth: .infinity, alignment: .leading)
                                            V2SettingsChevron()
                                        }.padding(16)
                                    }.buttonStyle(.plain)
                                    if proposal.id != proposals.last?.id { Divider().padding(.leading, 16) }
                                }
                            } else {
                                V2Row(title: "Loading designs…", subtitle: " ").redacted(reason: .placeholder)
                            }
                        }
                        if !projects.isEmpty {
                            V2Group(title: "Projects with a design") {
                                ForEach(projects) { project in
                                    Button { canvas = project.id } label: { V2Row(title: project.name, subtitle: project.description) }
                                }
                            }
                        }
                        if let error { Text(error).font(.footnote).foregroundStyle(WorkspaceStyle.danger(scheme)) }
                    }.padding(16)
                }.background(WorkspaceStyle.canvas(scheme)).navigationTitle("Design").navigationBarTitleDisplayMode(.inline)
            }
        }
        .designReview(item: $selected, store: store)
        .fullScreenCover(isPresented: Binding(get: { canvas != nil }, set: { if !$0 { canvas = nil } })) {
            if let canvas { V2DesignView(connection: store.connection, projectId: canvas) }
        }
        .task(id: projectId) { await load() }
        .onChange(of: store.snapshot.cursor) { _, _ in Task { await load() } }
    }
    private func load() async {
        do {
            proposals = try await store.client.designReviews(project: projectId)
            projects = try await store.client.designProjects()
            error = nil
        } catch { self.error = coordinatorErrorDescription(error) }
    }
    private func open(_ proposal: V2ReviewSummary) async {
        do { selected = try await store.client.designReview(project: proposal.projectId, item: proposal.id).item }
        catch { self.error = coordinatorErrorDescription(error) }
    }
}

/// Plain title and authoritative review metadata in Work and Waiting on you.
struct V2DesignWaitingRow: View {
    @Bindable var store: V2Store
    let item: InboxItem
    @State private var summary: V2ReviewSummary?
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "exclamationmark.circle").foregroundStyle(WorkspaceStyle.warning(scheme)).frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(summary?.title ?? item.title).font(.body).foregroundStyle(WorkspaceStyle.text(scheme))
                Text(summary?.inboxSubtitle ?? "Design · \(V2Labels.agentName(item))").font(.footnote).foregroundStyle(.secondary)
            }.fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
        }.multilineTextAlignment(.leading).padding(.horizontal, 14).padding(.vertical, 12).frame(minHeight: 64).contentShape(Rectangle())
            .task(id: store.snapshot.cursor) {
                guard let project = item.projectId ?? V2DesignReview.project(of: item.id) else { return }
                summary = try? await store.client.designReviews(project: project).first { $0.id == item.id }
            }
    }
}
#endif

#if os(iOS)
struct V2DesignReviewEntry: View {
    @Bindable var store: V2Store
    let item: InboxItem
    @State private var open = false
    var body: some View {
        Button { open = true } label: { V2DesignWaitingRow(store: store, item: item) }.buttonStyle(.plain)
            .designReview(item: Binding(get: { open ? item : nil }, set: { open = $0 != nil }), store: store)
    }
}
#endif
