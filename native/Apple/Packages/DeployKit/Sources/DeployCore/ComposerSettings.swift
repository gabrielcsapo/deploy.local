import Foundation

/// The adapter, model and effort the composer sends with the next message.
public struct ComposerSettings: Equatable, Sendable {
    public let adapter: String
    public let model: String
    public let effort: String
    public init(adapter: String, model: String, effort: String) { self.adapter = adapter; self.model = model; self.effort = effort }
}

/// The composer follows the task's latest run: opening a task, and each new run (from any device),
/// shows the adapter, model and effort that run used. `adopted` is the `<taskId>:<runId>` already
/// applied, so polling and a run finishing never replace what the person picked since. Returns nil
/// to keep the composer as it is (no runs yet: it keeps the computer's default or the first pick).
public func latestRunSettings(taskId: String, runs: [Run], adopted: String?) -> (settings: ComposerSettings, adopted: String)? {
    guard !taskId.isEmpty, let last = runs.last else { return nil }
    let marker = "\(taskId):\(last.id)"
    guard marker != adopted else { return nil }
    return (ComposerSettings(adapter: last.adapter, model: last.model ?? "", effort: last.effort ?? ""), marker)
}
