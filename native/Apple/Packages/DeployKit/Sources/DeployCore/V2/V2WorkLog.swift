import Foundation

/// One turn's work reads as one log, "Worked for 14m", instead of a row per step. What the agent
/// says while it works becomes a note in that log; what it says after its last step stays a reply.
/// Mirrors `workLogs` in app/routes/dashboard/v2/conversation/model.ts.
public enum V2WorkLog {
    /// A turn is a run of worklogs and replies between any other kind of event. Everything up to
    /// and including its last worklog becomes one log, replies in it becoming notes. A turn
    /// without a worklog, or whose work is a single worklog, is left as it is.
    public static func group(_ events: [ConversationEvent]) -> [ConversationEvent] {
        var result: [ConversationEvent] = []
        var turn: [ConversationEvent] = []
        func flush() {
            defer { turn = [] }
            guard let last = turn.lastIndex(where: { if case .worklog = $0 { true } else { false } }) else {
                result.append(contentsOf: turn); return
            }
            let work = Array(turn[...last])
            let logs = work.compactMap { event -> WorkLogEvent? in if case .worklog(let value) = event { value } else { nil } }
            if work.count == 1 { result.append(work[0]) }
            else if let firstLog = logs.first, let first = work.first, let end = work.last {
                let live = logs.contains(where: \.live)
                let steps = work.flatMap { event -> [WorkStep] in
                    switch event {
                    case .worklog(let value):
                        return value.steps.map { step in
                            var step = step
                            step.live = step.live ?? value.live
                            return step
                        }
                    case .reply(let value):
                        return [WorkStep(icon: .pulse, text: value.paragraphs.joined(separator: " "), glyph: "note")]
                    default: return []
                    }
                }
                let summary = "\(live ? "Working for" : "Worked for") \(took(from: first.v2Date, to: end.v2Date))"
                result.append(.worklog(WorkLogEvent(id: firstLog.id, at: first.v2Date, summary: summary, steps: steps, live: live)))
            }
            result.append(contentsOf: turn[(last + 1)...])
        }
        for event in events {
            switch event {
            case .worklog, .reply: turn.append(event)
            default: flush(); result.append(event)
            }
        }
        flush()
        return result
    }

    /// A note: what the agent said while it worked.
    public static func isNote(_ step: WorkStep) -> Bool { step.glyph == "note" }

    /// "45s", "14m", "1h 5m".
    public static func took(from: String, to: String) -> String {
        guard let start = date(from), let end = date(to) else { return "0s" }
        let seconds = max(0, Int((end.timeIntervalSince(start)).rounded()))
        if seconds < 60 { return "\(seconds)s" }
        let minutes = Int((Double(seconds) / 60).rounded())
        return minutes < 60 ? "\(minutes)m" : "\(minutes / 60)h \(minutes % 60)m"
    }

    private static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    /// A log starts open while any step runs or when one failed.
    public static func startsOpen(_ log: WorkLogEvent) -> Bool {
        log.live || log.steps.contains { $0.live == true || $0.tone == "fail" }
    }

    /// A step opens when it has a reason or log lines to show. Notes never open.
    public static func opens(_ step: WorkStep) -> Bool {
        !isNote(step) && (!(step.reason ?? "").isEmpty || !(step.tail ?? []).isEmpty)
    }

    /// Failed steps start open.
    public static func stepStartsOpen(_ step: WorkStep) -> Bool { opens(step) && step.tone == "fail" }

    /// A stored deploy summary from before deploys became work steps; the work log tells it now.
    public static func isDeploySummary(_ message: Message) -> Bool {
        message.id.hasPrefix("deployment:") || message.deployment != nil
    }

    /// Resolves a link the coordinator sent, relative ones against its origin. Only web links.
    public static func url(_ href: String, origin: String) -> URL? {
        guard let url = URL(string: href, relativeTo: URL(string: origin))?.absoluteURL,
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return nil }
        return url
    }
}
