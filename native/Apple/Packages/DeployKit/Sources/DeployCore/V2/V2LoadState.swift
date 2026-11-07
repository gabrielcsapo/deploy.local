import Foundation

/// One resource, including a successfully empty resource. Requests carry navigation-scoped
/// tickets: an old response may neither replace data nor finish a new screen's status.
public struct V2LoadState: Equatable, Sendable {
    public private(set) var hasData: Bool
    public private(set) var failed = false
    public private(set) var startedAt: ContinuousClock.Instant?
    public private(set) var completedAt: ContinuousClock.Instant?
    private var requests: [UUID: Bool] = [:]
    private var foreground: UUID?
    public init(hasData: Bool = false) { self.hasData = hasData }
    public var pending: Bool { !requests.isEmpty }
    public var showsSkeleton: Bool { !hasData && !failed }
    public mutating func begin(foreground: Bool, at now: ContinuousClock.Instant = .now) -> UUID {
        let ticket = UUID()
        requests[ticket] = foreground
        if foreground || !hasData { startedAt = startedAt ?? now }
        if foreground { self.foreground = ticket; completedAt = nil }
        return ticket
    }
    public mutating func promote(_ ticket: UUID, at now: ContinuousClock.Instant = .now) {
        guard requests[ticket] != nil else { return }
        requests[ticket] = true; foreground = ticket; completedAt = nil
        startedAt = startedAt ?? now
    }
    @discardableResult public mutating func succeed(_ ticket: UUID, at now: ContinuousClock.Instant = .now) -> Bool {
        guard requests.removeValue(forKey: ticket) != nil else { return false }
        // A first load showed skeletons, not Updating…, so it has no line to complete.
        let hadData = hasData
        hasData = true; failed = false
        if foreground == ticket { foreground = nil; completedAt = hadData ? now : nil; startedAt = nil }
        else if foreground == nil { startedAt = nil }
        return true
    }
    @discardableResult public mutating func fail(_ ticket: UUID) -> Bool {
        guard requests.removeValue(forKey: ticket) != nil else { return false }
        failed = true
        if foreground == ticket { foreground = nil; completedAt = nil }
        return true
    }
    public func isSlow(at now: ContinuousClock.Instant = .now) -> Bool {
        !failed && pending && startedAt.map { $0.duration(to: now) >= .seconds(10) } == true
    }
    public func header(at now: ContinuousClock.Instant = .now) -> String? {
        guard !failed else { return nil }
        if foreground != nil {
            guard hasData else { return nil }
            return isSlow(at: now) ? "Waiting for SER…" : "Updating…"
        }
        guard let completedAt else { return nil }
        let minutes = completedAt.duration(to: now).components.seconds / 60
        return minutes < 1 ? "Updated just now" : "Updated \(minutes) min ago"
    }
    public func retainingData() -> Self {
        var copy = self; copy.hasData = true; return copy
    }
    public mutating func leave() {
        requests.removeAll(); foreground = nil; startedAt = nil; completedAt = nil
    }
}
