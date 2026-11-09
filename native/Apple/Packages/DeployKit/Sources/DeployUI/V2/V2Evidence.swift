#if os(iOS)
import Foundation
import DeployCore

// Fixture navigation is compiled out on devices and in release builds.
enum V2Evidence {
    enum AgentsBoard: String, CaseIterable {
        case workEmpty = "WorkNoAgentsPhone", work = "WorkAgentsPhone"
        case newBlank = "NewAgentBlankPhone", newAgent = "NewAgentPhone", avatar = "AgentAvatarPickerPhone"
        case hello = "AgentHelloPhone", taught = "AgentTaughtPhone", beat = "AgentBeatPhone", chat = "AgentPhone"
        case menu = "AgentMenuPhone", info = "AgentInfoPhone", infoNew = "AgentInfoNewPhone", care = "AgentCareDetailsPhone"
        case routine = "AgentRoutinePhone", projects = "AgentBeatProjectsPhone", runs = "AgentRunsPhone"
        case approvals = "SettingsApprovalsPhone", rules = "AgentRulesPhone", mention = "TaskMentionPhone"

        var agentID: String {
            [.beat, .care, .projects].contains(self) ? "code-reviewer" : "release-notes-writer"
        }
    }
    // Phase 1 routing requires the local capture fixture as well as a known board.
    static var agentsBoard: AgentsBoard? {
        guard let board, fixtureURL?.port == 5186 else { return nil }
        return AgentsBoard(rawValue: board)
    }
    static var newAgentName: String? {
        guard let board = agentsBoard, [.newBlank, .newAgent, .avatar].contains(board) else { return nil }
        return board == .newBlank ? "" : "Release notes writer"
    }
    static var newAgentAvatar: V2AgentAvatar? {
        guard newAgentName != nil else { return nil }
        return agentsBoard == .newBlank ? .init(glyph: "variant07", color: "#ff4d6f") : .init(glyph: "variant28", color: "#af61f2")
    }
    // A fresh cache per launch keeps prior drafts/events and pending sends out of captures.
    private static let captureCache = FileManager.default.temporaryDirectory.appendingPathComponent("agents-p1-" + UUID().uuidString)
    static var reviewBoard: Bool { fixtureURL?.port == 5180 && board?.hasPrefix("DesignReview") == true }
    static var cacheDirectory: URL? { agentsBoard == nil && !loadingBoard && !reviewBoard ? nil : captureCache }
    static var loadingBoard: Bool {
        guard fixtureURL?.port == 5194, let board else { return false }
        return ["HomeLoadingPhone", "ProjectsLoadingPhone", "TaskLoadingPhone", "LiveLoadingPhone", "HomeLoadingSlowPhone", "HomeRefreshingPhone", "HomeUnavailablePhone", "PackagesPhone", "PackageVersionsPhone"].contains(board)
    }
    @MainActor static func prepareLoadingCache(connection: Connection) async {
        #if DEBUG && targetEnvironment(simulator)
        guard loadingBoard, board == "HomeRefreshingPhone", let origin = fixtureURL else { return }
        do {
            let (data, _) = try await URLSession.shared.data(from: origin.appendingPathComponent("fixture/cache"))
            let snapshot = try JSONDecoder().decode(V2Snapshot.self, from: data)
            try FileManager.default.createDirectory(at: captureCache, withIntermediateDirectories: true)
            try JSONEncoder().encode(snapshot).write(to: captureCache.appendingPathComponent(V2Client.notificationScope(connection) + ".json"))
        } catch { /* A fixture failure must not touch the user's regular cache. */ }
        #endif
    }
    // Keep the canonical web-fixture dates; show its 30 October conversation as Today.
    private static var referenceDate: Date { ISO8601DateFormatter().date(from: "2026-10-30T18:00:00-04:00")! }
    private static var referenceCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        return calendar
    }
    @MainActor static func isToday(_ value: String) -> Bool {
        guard agentsBoard != nil, let date = V2Store.date(value) else { return V2Store.isToday(value) }
        return referenceCalendar.isDate(date, inSameDayAs: referenceDate)
    }
    static func shortDate(_ value: String) -> String {
        guard agentsBoard != nil else { return V2Labels.shortDate(value) }
        return V2Labels.shortDate(value, now: referenceDate, calendar: referenceCalendar)
    }
    // The phase-1 fixture lacks stage/access fields; keep its board-only scope here.
    static func projectAccess(agent: V2Agent, project: V2Project) -> Bool? {
        guard agentsBoard != nil, agent.id == "code-reviewer" else { return nil }
        return ["home-gym", "tally", "deploy.local", "immich"].contains(project.id)
    }
    static func projectStage(_ project: V2Project) -> String {
        if agentsBoard != nil, project.id == "immich" { return "Maintained" }
        return project.stage?.capitalized ?? "Active"
    }
    static func projectAccessNote(agent: V2Agent) -> String? {
        guard agentsBoard != nil, agent.id == "code-reviewer" else { return nil }
        return "recipes needs access before this agent can check it. Choosing a project never grants access.\nDone projects are excluded."
    }
    static var itemConfirmationNote: String? {
        agentsBoard == .projects ? "Starts after you confirm. Visible fixes bring a design review before code. Above Small, it brings a question." : nil
    }
    static func elapsed(_ value: String) -> String {
        V2Labels.elapsed(value, now: agentsBoard == nil ? Date() : referenceDate)
    }
    static func historyDate(_ value: String, timezone: String) -> String {
        V2Labels.historyDate(value, timezone: timezone, now: agentsBoard == nil ? Date() : referenceDate)
    }
    private static var fixtureURL: URL? {
        #if DEBUG && targetEnvironment(simulator)
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "--v2-fixture"), arguments.indices.contains(index + 1),
              let url = URL(string: arguments[index + 1]), url.host == "127.0.0.1", url.scheme == "http",
              let port = url.port, (5180...5199).contains(port) else { return nil }
        return url
        #else
        return nil
        #endif
    }
    static var board: String? {
        #if DEBUG && targetEnvironment(simulator)
        let arguments = ProcessInfo.processInfo.arguments
        guard fixtureURL != nil,
              let index = arguments.firstIndex(of: "--v2-board"), arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
        #else
        return nil
        #endif
    }
}
#endif
