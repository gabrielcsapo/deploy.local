import SwiftUI
import DeployCore
import DeployUI

@main
struct DeployIOSApp: App {
    @State private var store = WorkspaceStore()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            DeployWorkspaceView(store: store)
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { Task { await store.start() } }
                    else if phase == .background { store.suspend() }
                }
        }
    }
}
