import Foundation

extension ControlSession {
    public var isEnded: Bool { ["stopped", "suspended"].contains(status) }

    public var endedReason: String {
        let reason = reason ?? ""
        if reason.hasPrefix("Interaction outcome uncertain") { return "The session stopped after an uncertain action" }
        if reason == "Stopped by agent" { return "The agent finished with \(targetLabel)" }
        if reason == "Stopped by user" { return "You stopped this session" }
        if reason.hasPrefix("Control connection expired") || status == "suspended" { return "The connection to \(targetLabel) timed out" }
        return "This session ended"
    }
}
