import Foundation
import Testing
@testable import DeployCore

struct V2AgentPresentationTests {
    private let now = ISO8601DateFormatter().date(from: "2026-10-30T18:00:00-04:00")!
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        return calendar
    }

    @Test func conversationDatesUseTheReferenceClockAndCalendar() {
        let cases = [
            ("2026-10-30T22:00:00Z", "now"),
            ("2026-10-30T21:59:01.000Z", "now"),
            ("2026-10-30T21:59:00Z", "5:59"),
            ("2026-10-30T07:02:00-04:00", "7:02"),
            ("2026-10-29T12:00:00-04:00", "Yesterday"),
            ("2026-10-26T12:00:00-04:00", "Mon"),
            ("2026-10-27T12:00:00-04:00", "Tue"),
            ("2026-10-24T12:00:00-04:00", "Sat"),
            ("2026-10-23T12:00:00-04:00", "23 Oct"),
            ("2026-10-12T12:00:00-04:00", "12 Oct"),
            ("bad date", "Unavailable"),
        ]
        for (date, expected) in cases {
            #expect(V2Labels.shortDate(date, now: now, calendar: calendar) == expected)
        }
        // A UTC date on the next day is still today in the fixture's time zone.
        #expect(V2Labels.shortDate("2026-10-31T02:00:00Z", now: now, calendar: calendar) == "10:00")
    }

    @Test func historyUsesTheItemsClockAndDescribesTheLastRun() {
        #expect(V2Labels.historyDate("2026-10-30T20:00:00Z", timezone: "America/New_York", now: now) == "Friday, 16:00")
        #expect(V2Labels.historyDate("2026-10-23T20:00:00Z", timezone: "America/New_York", now: now) == "Last Friday, 16:00")
        #expect(V2Labels.elapsed("2026-10-30T20:00:00Z", now: now) == "2h")
        let item = V2LooksAfterItem(when: .init(every: "week", day: 5, time: "16:00"))
        #expect(item.recurringWhenLabel == "Fridays 16:00")
        #expect(item.whenLabel == "Friday 16:00")
    }

    @Test func approvalSummariesRespectReadOnlyModesAndProjectOverrides() throws {
        let empty = try JSONDecoder().decode(V2Approvals.self, from: Data(#"{"rules":[]}"#.utf8))
        #expect(empty.summary(agent: "writer") == "Asks before everything")
        let start = try JSONDecoder().decode(V2Approvals.self, from: Data(#"{"rules":[{"agent":"writer","action":"start-task","mode":"allow"}]}"#.utf8))
        #expect(start.summary(agent: "writer") == "Starts tasks · asks before the rest")
        let scoped = try JSONDecoder().decode(V2Approvals.self, from: Data(#"{"rules":[{"agent":"writer","action":"start-task","mode":"allow","projectId":"home-gym"}]}"#.utf8))
        #expect(scoped.summary(agent: "writer") == "Asks before everything")
        let restricted = try JSONDecoder().decode(V2Approvals.self, from: Data(#"{"rules":[{"agent":"writer","action":"start-task","mode":"allow"},{"agent":"writer","action":"merge","mode":"never"}]}"#.utf8))
        #expect(restricted.summary(agent: "writer").contains("Never"))
        #expect(!restricted.summary(agent: "writer").contains("asks before the rest"))
    }
}
