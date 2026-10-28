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
        return CredentialVault.load()
    }
    var body: some Scene {
        WindowGroup {
            DeployV2Root(store: store)
                .task(id: store.connection) { await pushDelegate.register(connection: store.connection) }
        }
    }
}
