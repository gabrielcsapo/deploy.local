#if os(iOS)
import SwiftUI
import UserNotifications

struct V2NotificationSettings: View {
    @State private var status = "Checking…"
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var phase
    var body: some View {
        NavigationStack {
            V2Page(title: "Notifications") {
                V2Group {
                    V2Row(title: "Decisions", subtitle: "Everything in Waiting on you", icon: "bell", trailing: status)
                    V2Row(title: "Failing apps", subtitle: "When Live turns red", icon: "waveform.path.ecg", trailing: status)
                    V2Row(title: "Quiet hours", subtitle: "Use iPhone Focus to choose when notifications arrive", icon: "moon")
                }
                Text("Your coordinator sends decisions and failing-app alerts together. Separate switches and rollback exceptions are not available yet.").font(.system(size: 15)).foregroundStyle(.secondary)
                Text("Approve and Not now require unlocking your iPhone. Decisions that need confirmation open in the app.").font(.system(size: 15)).foregroundStyle(.secondary)
                Button("Open iPhone notification settings") { if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) } }.buttonStyle(V2ActionStyle()).disabled(V2Evidence.board != nil)
            }.navigationBarTitleDisplayMode(.inline).toolbar { Button("Done") { dismiss() } }
                .task { await refresh() }.onChange(of: phase) { _, value in if value == .active { Task { await refresh() } } }
        }
    }
    private func refresh() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        status = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional ? "On" : "Off"
    }
}
#endif
