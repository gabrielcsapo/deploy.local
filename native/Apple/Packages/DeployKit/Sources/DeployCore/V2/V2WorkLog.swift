import Foundation

/// The steps an agent takes between messages read as one work log, "Worked for 14m",
/// instead of a row each. Mirrors `workLogs` in app/routes/dashboard/v2/conversation/model.ts.
public enum V2WorkLog {
    /// Joins each run of consecutive worklog events into one. A run of one keeps its own summary.
    public static func group(_ events: [ConversationEvent]) -> [ConversationEvent] {
        var result: [ConversationEvent] = []
        var run: [WorkLogEvent] = []
        func flush() {
            if run.count == 1 { result.append(.worklog(run[0])) }
            else if let first = run.first, let last = run.last {
                let live = run.contains(where: \.live)
                let steps = run.flatMap { event in
                    event.steps.map { step -> WorkStep in
                        var step = step
                        step.live = step.live ?? event.live
                        return step
                    }
                }
                let summary = "\(live ? "Working for" : "Worked for") \(took(from: first.at, to: last.at))"
                result.append(.worklog(WorkLogEvent(id: first.id, at: first.at, summary: summary, steps: steps, live: live)))
            }
            run = []
        }
        for event in events {
            if case .worklog(let value) = event { run.append(value) }
            else { flush(); result.append(event) }
        }
        flush()
        return result
    }

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

    /// A step opens when it has a reason or log lines to show.
    public static func opens(_ step: WorkStep) -> Bool {
        !(step.reason ?? "").isEmpty || !(step.tail ?? []).isEmpty
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
