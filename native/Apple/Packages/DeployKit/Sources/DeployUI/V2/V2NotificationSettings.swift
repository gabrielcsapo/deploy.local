#if os(iOS)
import SwiftUI
import DeployCore
import UserNotifications

struct V2NotificationSettings: View {
    let store: V2Store
    @State private var status = "Checking…"
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var phase
    var body: some View {
        NavigationStack {
            V2Page(title: "Notifications") {
                V2NotificationControls(store: store)
                Text("iPhone notifications: \(status)").foregroundStyle(.secondary)
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
struct V2NotificationControls: View {
    let store: V2Store
    var compact = false
    @State private var preferences: V2NotificationPreferences?
    @State private var busy = false
    @State private var error: String?
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        V2Group(title: "Notify me about", compact: compact) {
            if let preferences {
                preference("Decisions", subtitle: "Everything in Waiting on you", icon: "bell", value: preferences.decisions, key: \.decisions)
                Divider()
                preference("Failing apps", subtitle: "When Live turns red", icon: "waveform.path.ecg", value: preferences.failingApps, key: \.failingApps)
                Divider()
                preference("Quiet hours", subtitle: "10 PM to 7 AM, except rollbacks", icon: "clock", value: preferences.quietHours, key: \.quietHours)
            } else { Text("Loading notification preferences…").padding() }
            if let error { Text(error).foregroundStyle(.red).padding(); Button("Retry") { Task { await load() } } }
        }.task { await load() }
    }
    private func preference(_ title: String, subtitle: String, icon: String, value: Bool, key: WritableKeyPath<V2NotificationPreferences, Bool>) -> some View {
        Toggle(isOn: Binding(get: { value }, set: { next in
            guard var updated = preferences else { return }
            updated[keyPath: key] = next
            updated.timeZone = TimeZone.current.identifier
            busy = true; error = nil
            Task { do { preferences = try await store.client.saveNotificationPreferences(updated) } catch { self.error = error.localizedDescription }; busy = false }
        })) {
            HStack(spacing: 12) {
                if compact { Image(systemName: icon).foregroundStyle(WorkspaceStyle.secondary(scheme)).frame(width: 20).accessibilityHidden(true) }
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 17))
                    Text(subtitle).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
                }
            }
        }.padding(.horizontal, 16).padding(.vertical, compact ? 6 : 16).frame(minHeight: 44).disabled(busy)
    }
    private func load() async {
        do { preferences = try await store.client.notificationPreferences(); error = nil } catch { self.error = error.localizedDescription }
    }
}
#endif
