import Foundation

public struct V2Package: Decodable, Identifiable, Sendable {
    public struct Latest: Decodable, Sendable { public var version: String }
    public var id: String
    public var name: String
    public var ecosystem: String
    public var project: String?
    public var latest: Latest?
    public var kindLabel: String { ecosystem == "cargo" ? "Cargo crate" : ecosystem }
    public var subtitle: String { kindLabel + (project.map { " · from \($0)" } ?? "") }
}
public struct V2PackageVersion: Decodable, Identifiable, Sendable {
    public struct Pipeline: Decodable, Sendable { public var id: String; public var pullNumber: Int? }
    public var id: String { version }
    public var version: String
    public var publishedVia: String
    public var publishedBy: String
    public var publishedByYou: Bool
    public var createdAt: String
    public var commit: String?
    public var pipeline: Pipeline?
    public var deprecated: String?
    public var attribution: String {
        if publishedVia == "import" { return "Brought over from npmjs.org" }
        if publishedVia == "release" {
            return "Published by the pipeline" + (pipeline?.pullNumber.map { " when #\($0) merged" } ?? "") + (commit.map { " · \($0.prefix(7))" } ?? "")
        }
        return "Published by \(publishedByYou ? "you" : publishedBy)"
    }
}
public struct V2PackageCopies: Decodable, Sendable {
    public struct Source: Decodable, Identifiable, Sendable {
        public var id: String { name }
        public var name: String
        public var reachable: Bool
        public var checkedAt: String?
    }
    public struct Project: Decodable, Sendable {
        public struct Removed: Decodable, Sendable { public var name: String; public var version: String }
        public var missing: Int
        public var checkedAt: String?
        public var removed: [Removed]
    }
    public struct Storage: Decodable, Sendable {
        public var bytes: Double
        public var limit: Double?
        /// Reads the same as web for the same bytes: gigabytes of 1024³, then the limit.
        public var description: String {
            let gigabyte = 1_073_741_824.0
            let used = String(format: "%.1f GB", locale: Locale(identifier: "en_US_POSIX"), bytes / gigabyte)
            guard let limit else { return used }
            let total = limit / gigabyte
            let format = total == total.rounded() ? "%.0f GB" : "%.1f GB"
            return "\(used) of \(String(format: format, locale: Locale(identifier: "en_US_POSIX"), total))"
        }
    }
    public var sources: [Source]
    public var projects: [Project]
    public var storage: Storage
    public var keptDescription: String {
        if let problem { return problem }
        if projects.contains(where: { $0.checkedAt == nil }) { return "Not checked yet" }
        return "Nothing missing"
    }
    /// What the Settings row says after the count, worst first: a source being down
    /// outranks "nothing missing", but not a package that can't be installed at all.
    public func summary(privateCount: Int) -> String {
        let state: String
        if let problem { state = problem }
        else if sources.contains(where: { !$0.reachable }) { state = "using copies" }
        else { state = keptDescription.lowercased() }
        return "\(privateCount) private · \(state)"
    }
    private var problem: String? {
        let removed = projects.reduce(0) { $0 + $1.removed.count }
        if removed > 0 { return "\(removed) removed" }
        let missing = projects.reduce(0) { $0 + $1.missing }
        return missing > 0 ? "\(missing) missing" : nil
    }
}
extension V2Client {
    public func packages() async throws -> [V2Package] {
        struct Response: Decodable, Sendable { var packages: [V2Package] }
        let response: Response = try await client.request("/api/packages")
        return response.packages
    }
    public func packageVersions(_ package: V2Package) async throws -> [V2PackageVersion] {
        struct Response: Decodable, Sendable { var versions: [V2PackageVersion] }
        let response: Response = try await client.request("/api/packages/\(Self.segment(package.ecosystem))/\(Self.segment(package.name))")
        return response.versions
    }
    public func packageCopies() async throws -> V2PackageCopies { try await client.request("/api/packages/cache") }
}
