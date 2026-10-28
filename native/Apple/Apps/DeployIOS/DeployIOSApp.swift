import SwiftUI
import DeployCore
import DeployUI

@main
struct DeployIOSApp: App {
    @UIApplicationDelegateAdaptor(DeployPushDelegate.self) private var pushDelegate
    @State private var store = WorkspaceStore(connection: initialConnection())
    private static func initialConnection() -> Connection? {
        #if DEBUG && targetEnvironment(simulator)
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "--v2-fixture"), arguments.indices.contains(index + 1),
           let url = URL(string: arguments[index + 1]), url.scheme == "http", url.host == "127.0.0.1",
           let port = url.port, (5180...5199).contains(port) {
            return Connection(origin: url.absoluteString, username: "gabriel", token: "fixture-only")
        }
        #endif
        return V2PairingVault.load()?.connection ?? CredentialVault.load()
    }
    /// Fixture captures run with a fake connection; asking for notification permission would cover the screen.
    private static var isFixtureCapture: Bool {
        #if DEBUG && targetEnvironment(simulator)
        return ProcessInfo.processInfo.arguments.contains("--v2-fixture")
        #else
        return false
        #endif
    }
    var body: some Scene {
        WindowGroup {
            DeployV2Root(store: store) { connection in store = WorkspaceStore(connection: connection) }
                .task(id: store.connection) {
                    guard !Self.isFixtureCapture else { return }
                    await pushDelegate.register(connection: store.connection)
                }
        }
    }
}
