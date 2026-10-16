import SwiftUI
import AppKit
import DeployCore
import DeployUI

@main
struct DeployMacApp: App {
    @State private var store = WorkspaceStore()
    var body: some Scene {
        WindowGroup {
            DeployWorkspaceView(store: store)
                .frame(minWidth: 920, minHeight: 620)
                .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.willSleepNotification)) { _ in
                    store.suspend()
                }
                .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didWakeNotification)) { _ in
                    Task { await store.start() }
                }
        }
        .defaultSize(width: 1280, height: 840)
        .windowToolbarStyle(.unifiedCompact)
        .commands {
            CommandGroup(after: .newItem) {
                Button("Refresh workspace") { Task { await store.refresh() } }.keyboardShortcut("r")
            }
        }
    }
}
