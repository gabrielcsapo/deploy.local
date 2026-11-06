import Foundation
import Testing
@testable import DeployCore

@Suite struct V2PackagesTests {
    private func copies(reachable: Bool = true, missing: Int = 0, removed: Int = 0, checked: Bool = true, bytes: Double = 1.3 * 1_073_741_824, limit: Double? = 20 * 1_073_741_824) throws -> V2PackageCopies {
        let removals = (0..<removed).map { _ in ["name": "left-pad", "version": "1.3.0"] }
        var storage: [String: Any] = ["bytes": bytes]
        if let limit { storage["limit"] = limit }
        let body: [String: Any] = [
            "sources": [["name": "npmjs.org", "reachable": reachable, "checkedAt": "2026-11-06T12:00:00Z"]],
            "projects": [["missing": missing, "checkedAt": checked ? "2026-11-06T12:00:00Z" as Any : NSNull(), "removed": removals]],
            "storage": storage,
        ]
        return try JSONDecoder().decode(V2PackageCopies.self, from: JSONSerialization.data(withJSONObject: body))
    }

    @Test func storageReadsLikeWebForTheSameBytes() throws {
        #expect(try copies().storage.description == "1.3 GB of 20 GB")
        #expect(try copies(bytes: 6.2 * 1_073_741_824).storage.description == "6.2 GB of 20 GB")
        #expect(try copies(limit: 1.5 * 1_073_741_824).storage.description == "1.3 GB of 1.5 GB")
        #expect(try copies(limit: nil).storage.description == "1.3 GB")
    }

    @Test func theSummaryNeverHidesAProblem() throws {
        #expect(try copies().summary(privateCount: 3) == "3 private · nothing missing")
        #expect(try copies(reachable: false).summary(privateCount: 3) == "3 private · using copies")
        #expect(try copies(missing: 2).summary(privateCount: 3) == "3 private · 2 missing")
        #expect(try copies(removed: 1).summary(privateCount: 3) == "3 private · 1 removed")
        #expect(try copies(checked: false).summary(privateCount: 3) == "3 private · not checked yet")
        // Worst first: removed, then missing, then using copies.
        #expect(try copies(reachable: false, missing: 2).summary(privateCount: 3) == "3 private · 2 missing")
        #expect(try copies(reachable: false, missing: 2, removed: 1).summary(privateCount: 3) == "3 private · 1 removed")
        #expect(try copies(reachable: false, checked: false).summary(privateCount: 3) == "3 private · using copies")
    }

    @Test func keptRowSaysWhatIsKept() throws {
        // A source being down doesn't change what is kept.
        #expect(try copies(reachable: false).keptDescription == "Nothing missing")
        #expect(try copies(missing: 2).keptDescription == "2 missing")
        #expect(try copies(removed: 1).keptDescription == "1 removed")
        #expect(try copies(checked: false).keptDescription == "Not checked yet")
    }

    @Test func versionDatesCarryTheYearAndTodayItsClock() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        let now = ISO8601DateFormatter().date(from: "2026-11-06T18:00:00Z")!
        let cases = [
            ("2026-11-06T07:57:00-05:00", "Today, 7:57 AM"),
            ("2026-11-06T13:05:00-05:00", "Today, 1:05 PM"),
            ("2026-11-05T12:00:00-05:00", "Nov 5, 2026"),
            ("2026-10-23T12:00:00.000-04:00", "Oct 23, 2026"),
            ("2025-08-14T12:00:00-04:00", "Aug 14, 2025"),
            ("bad date", "Unavailable"),
        ]
        for (date, expected) in cases {
            #expect(V2Labels.versionDate(date, now: now, calendar: calendar) == expected)
        }
    }

    @Test func packagesNameTheirKind() throws {
        func package(_ ecosystem: String, _ project: String?) throws -> V2Package {
            var body: [String: Any] = ["id": "x", "name": "x", "ecosystem": ecosystem]
            if let project { body["project"] = project }
            return try JSONDecoder().decode(V2Package.self, from: JSONSerialization.data(withJSONObject: body))
        }
        #expect(try package("npm", "deploy.local").subtitle == "npm · from deploy.local")
        #expect(try package("cargo", "mdink").subtitle == "Cargo crate · from mdink")
        #expect(try package("npm", nil).subtitle == "npm")
    }
}
