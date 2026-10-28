import UIKit
import UserNotifications
import DeployCore
import DeployUI

@MainActor final class DeployPushDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    private var connection: Connection?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let approve = UNNotificationAction(identifier: "approve", title: "Approve", options: [.authenticationRequired])
        let later = UNNotificationAction(identifier: "not-now", title: "Not now", options: [.authenticationRequired])
        let open = UNNotificationAction(identifier: "open", title: "Open", options: [.foreground])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "DEPLOY_DECISION", actions: [approve, later, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: "DEPLOY_OPEN", actions: [open], intentIdentifiers: [])
        ])
        return true
    }
    func register(connection: Connection?) async {
        self.connection = connection
        guard let connection else { return }
        do {
            let permitted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
            guard permitted else { return }
            UIApplication.shared.registerForRemoteNotifications()
            if let token = UserDefaults.standard.string(forKey: "deploy.apns.token") { try await registerToken(token, connection: connection) }
        } catch { print("[push] Registration unavailable; retrying when the app reconnects.") }
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(token, forKey: "deploy.apns.token")
        guard let connection else { return }
        Task { do { try await registerToken(token, connection: connection) } catch { print("[push] Device registration will retry on reconnect.") } }
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("[push] Remote registration unavailable. Waiting on you still refreshes in the app.")
    }
    private func registerToken(_ token: String, connection: Connection) async throws {
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        guard self.connection == connection else { return }
        let client = V2Client(connection: connection)
        try await client.registerDevice(token: token, environment: environment)
        if self.connection != connection { try? await client.removeDevice(token: token) }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        // Read everything from the non-Sendable response here, then hop to the main actor with plain values.
        let info = response.notification.request.content.userInfo
        let action = response.actionIdentifier
        await handle(
            action: action,
            itemId: info["inboxItemId"] as? String,
            appId: info["appId"] as? String,
            scope: info["deviceScope"] as? String,
            actionId: info[action == "approve" ? "approveActionId" : "notNowActionId"] as? String
        )
    }
    private func handle(action: String, itemId: String?, appId: String?, scope: String?, actionId: String?) async {
        guard let connection = self.connection ?? CredentialVault.load(), scope == V2Client.notificationScope(connection) else { return }
        if ["approve", "not-now"].contains(action), let itemId, let actionId {
            do {
                let client = V2Client(connection: connection)
                _ = try await client.handleNotification(scope: scope, itemId: itemId, action: action, actionId: actionId)
            } catch {
                let content = UNMutableNotificationContent()
                content.title = "Answer not sent"
                content.body = "Open deploy.local on your home network to review this decision."
                content.categoryIdentifier = "DEPLOY_OPEN"
                content.userInfo = ["inboxItemId": itemId]
                try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "answer-failed-" + itemId, content: content, trigger: nil))
            }
        }
        guard action == "open" || action == UNNotificationDefaultActionIdentifier else { return }
        var route: [String: String] = [:]
        if let itemId { route["inboxItemId"] = itemId }
        if let appId { route["appId"] = appId }
        UserDefaults.standard.set(route, forKey: "deploy.v2.notificationRoute")
        NotificationCenter.default.post(name: .v2OpenNotification, object: nil, userInfo: route)
    }
}
