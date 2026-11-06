import Foundation

public struct V2Package: Decodable, Identifiable, Sendable {
    public struct Latest: Decodable, Sendable { public var version: String }
    public var id: String
    public var name: String
    public var ecosystem: String
    public var project: String?
    public var latest: Latest?
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
    public struct Storage: Decodable, Sendable { public var bytes: Double }
    public var sources: [Source]
    public var projects: [Project]
    public var storage: Storage
    public var keptDescription: String {
        let missing = projects.reduce(0) { $0 + $1.missing }
        if projects.contains(where: { !$0.removed.isEmpty }) { return "Removed" }
        if missing > 0 { return "\(missing) missing" }
        if projects.contains(where: { $0.checkedAt == nil }) { return "Not checked yet" }
        return "Nothing missing"
    }
}
extension V2Client {
    public func packages() async throws -> [V2Package] {
        struct Response: Decodable, Sendable { var packages: [V2Package] }
        let response: Response = try await client.request("/api/v2/packages")
        return response.packages
    }
    public func packageVersions(_ package: V2Package) async throws -> [V2PackageVersion] {
        struct Response: Decodable, Sendable { var versions: [V2PackageVersion] }
        let response: Response = try await client.request("/api/v2/packages/\(Self.segment(package.ecosystem))/\(Self.segment(package.name))")
        return response.versions
    }
    public func packageCopies() async throws -> V2PackageCopies { try await client.request("/api/v2/packages/cache") }
}
